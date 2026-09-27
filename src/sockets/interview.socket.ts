import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { JwtUserPayload, UserRole } from '../types/auth.types';
import { normalizeRole } from '../middlewares/auth.middleware';
import * as sessionService from '../services/session.service';
import * as codeRunnerService from '../services/codeRunner.service';
import { executeCodeSchema } from '../validators/codeRunner.validator';
import { AppError } from '../middlewares/errorHandler';
import {
  ChatMessagePayload,
  CodeChangePayload,
  RecruiterIntervenePayload,
  RoomJoinPayload,
} from '../types/session.types';

// Map to manage debounced database persistence for active coding sessions
const codeDebounceTimers = new Map<string, NodeJS.Timeout>();
const CODE_SAVE_DEBOUNCE_MS = 500;
const MAX_CODE_LENGTH = 100_000;
const MAX_CHAT_LENGTH = 5_000;

const roomFor = (sessionId: string) => `interview:${sessionId}`;

export interface CodeRunPayload {
  sessionId: string;
  language: string;
  code: string;
  testCases?: any[];
  timeoutMs?: number;
}

/**
 * Socket.IO authentication middleware verifying JWT token during handshake
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
  try {
    const rawAuth = socket.handshake.auth?.token || socket.handshake.headers?.authorization;

    if (!rawAuth || typeof rawAuth !== 'string') {
      return next(new Error('Authentication error: Missing JWT token in handshake'));
    }

    const token = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7).trim() : rawAuth.trim();

    if (!token) {
      return next(new Error('Authentication error: Token cannot be empty'));
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtUserPayload;
    const role = normalizeRole(decoded.role);

    if (!role) {
      return next(new Error('Authentication error: Invalid user role in token'));
    }

    socket.data.user = {
      ...decoded,
      role,
    };
    socket.data.userRole = role;

    next();
  } catch (error: any) {
    const msg = error.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    next(new Error(`Authentication error: ${msg}`));
  }
}

/**
 * Initializes real-time interview room Socket.IO handlers
 */
export function initInterviewSocket(io: SocketIOServer): void {
  // Apply handshake JWT authentication
  io.use(socketAuthMiddleware);

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as JwtUserPayload;
    console.log(`[Socket] User connected: ${user?.email} (${user?.role}) [SocketID: ${socket.id}]`);

    /**
     * Room events are only accepted from sockets that passed the room:join access check
     */
    const requireJoined = (sessionId: unknown, callback?: (res: any) => void): sessionId is string => {
      if (typeof sessionId === 'string' && socket.rooms.has(roomFor(sessionId))) {
        return true;
      }
      const message = 'Join the session room (room:join) before sending events to it';
      if (callback) callback({ success: false, message });
      socket.emit('error', { message });
      return false;
    };

    /**
     * room:join
     * Candidate or Recruiter joins interview session room
     */
    socket.on('room:join', async (payload: RoomJoinPayload, callback?: (res: any) => void) => {
      try {
        const { sessionId } = payload || {};
        if (!sessionId || typeof sessionId !== 'string') {
          if (callback) callback({ success: false, message: 'sessionId is required' });
          return;
        }

        // Only participants (or admins) may join; throws 404 otherwise
        let session;
        try {
          session = await sessionService.getSessionForUser(sessionId, user);
        } catch (err: any) {
          const message = err instanceof AppError ? err.message : 'Failed to join room';
          if (callback) callback({ success: false, message });
          socket.emit('error', { message });
          return;
        }

        const roomName = roomFor(sessionId);
        socket.join(roomName);

        const joinResponse = {
          success: true,
          sessionId,
          room: roomName,
          user: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          currentCode: session.codeState,
          status: session.status,
        };

        // Acknowledge join to the connecting client
        socket.emit('room:joined', joinResponse);
        if (callback) callback(joinResponse);

        // Broadcast to existing room participants
        socket.to(roomName).emit('user:joined', {
          sessionId,
          user: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          timestamp: new Date().toISOString(),
        });

        console.log(`[Socket] ${user.email} (${user.role}) joined ${roomName}`);
      } catch (err: any) {
        console.error('[Socket] room:join error:', err);
        socket.emit('error', { message: err?.message || 'Failed to join room' });
      }
    });

    /**
     * code:change
     * Broadcast live code edits to observers and debounce auto-save to DB
     */
    socket.on('code:change', async (payload: CodeChangePayload) => {
      try {
        const { sessionId, code, cursorPosition } = payload || {};
        if (!sessionId || typeof code !== 'string' || code.length > MAX_CODE_LENGTH) {
          return;
        }
        if (!requireJoined(sessionId)) return;

        const roomName = roomFor(sessionId);

        // 1. Broadcast live code updates to all observers/participants in the room
        const updatePayload = {
          sessionId,
          code,
          cursorPosition,
          sender: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          timestamp: new Date().toISOString(),
        };

        socket.to(roomName).emit('code:update', updatePayload);
        socket.to(roomName).emit('code:change', updatePayload);

        // 2. Debounce auto-save to database / session store
        const existingTimer = codeDebounceTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const newTimer = setTimeout(async () => {
          try {
            await sessionService.updateSessionCode(sessionId, code);
            io.to(roomName).emit('code:saved', {
              sessionId,
              timestamp: new Date().toISOString(),
            });
          } catch (saveErr) {
            console.error(`[Socket] Debounced auto-save error for ${sessionId}:`, saveErr);
          } finally {
            codeDebounceTimers.delete(sessionId);
          }
        }, CODE_SAVE_DEBOUNCE_MS);

        codeDebounceTimers.set(sessionId, newTimer);
      } catch (err: any) {
        console.error('[Socket] code:change error:', err);
      }
    });

    /**
     * code:run
     * Triggers sandboxed code execution and broadcasts live output stream/results back to the room
     */
    socket.on('code:run', async (payload: CodeRunPayload, callback?: (res: any) => void) => {
      try {
        const { sessionId, ...runInput } = payload || ({} as CodeRunPayload);
        if (!sessionId) {
          if (callback) callback({ success: false, message: 'sessionId is required' });
          return;
        }
        if (!requireJoined(sessionId, callback)) return;

        // Same validation as the REST endpoint (language, code size, timeout bounds)
        const parsed = executeCodeSchema.safeParse({ ...runInput, language: runInput.language || 'javascript' });
        if (!parsed.success) {
          const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          if (callback) callback({ success: false, message });
          return;
        }
        const input = parsed.data;

        const roomName = roomFor(sessionId);

        // Notify room that execution has started
        io.to(roomName).emit('code:executing', {
          sessionId,
          language: input.language,
          sender: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          timestamp: new Date().toISOString(),
        });

        // Run code in isolated sandbox
        const result = await codeRunnerService.executeCodeForUser(user.userId, input);

        // Update session code in background
        sessionService.updateSessionCode(sessionId, input.code).catch((saveErr) => {
          console.error(`[Socket] Failed to save code for ${sessionId}:`, saveErr);
        });

        const responsePayload = {
          sessionId,
          result,
          sender: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          timestamp: new Date().toISOString(),
        };

        // Broadcast completion and execution output to all participants in the room
        io.to(roomName).emit('code:executed', responsePayload);
        io.to(roomName).emit('code:result', responsePayload);

        if (callback) callback({ success: true, data: result });
        console.log(`[Socket] Executed code for ${sessionId} [Status: ${result.status}, Time: ${result.executionTimeMs}ms]`);
      } catch (err: any) {
        const message = err instanceof AppError ? err.message : 'Failed to execute code';
        if (!(err instanceof AppError)) console.error('[Socket] code:run error:', err);
        if (callback) callback({ success: false, message });
        socket.emit('error', { message });
      }
    });

    /**
     * chat:message
     * Handle real-time question and answer transcripts between candidate and AI/recruiter
     */
    socket.on('chat:message', async (payload: ChatMessagePayload, callback?: (res: any) => void) => {
      try {
        const { sessionId, message } = payload || {};
        if (!sessionId || !message || typeof message !== 'string') {
          if (callback) callback({ success: false, message: 'sessionId and message are required' });
          return;
        }
        if (message.length > MAX_CHAT_LENGTH) {
          if (callback) callback({ success: false, message: `message cannot exceed ${MAX_CHAT_LENGTH} characters` });
          return;
        }
        if (!requireJoined(sessionId, callback)) return;

        const roomName = roomFor(sessionId);
        const chatData = {
          id: randomUUID(),
          sessionId,
          message: message.trim(),
          sender: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          role: user.role,
          timestamp: payload.timestamp || new Date().toISOString(),
        };

        // Broadcast to everyone in the room (including sender)
        io.to(roomName).emit('chat:message', chatData);
        io.to(roomName).emit('chat:receive', chatData);

        if (callback) callback({ success: true, data: chatData });
      } catch (err: any) {
        console.error('[Socket] chat:message error:', err);
      }
    });

    /**
     * recruiter:intervene
     * Recruiter sends manual question / hint / override to candidate
     */
    socket.on('recruiter:intervene', async (payload: RecruiterIntervenePayload, callback?: (res: any) => void) => {
      try {
        const { sessionId, interventionType, content } = payload || {};
        if (!sessionId || !content) {
          if (callback) callback({ success: false, message: 'sessionId and content are required' });
          return;
        }

        // Enforce Recruiter / Admin authorization
        if (user.role !== UserRole.RECRUITER && user.role !== UserRole.ADMIN) {
          socket.emit('error', { message: 'Unauthorized: Only Recruiters and Admins can intervene in sessions' });
          if (callback) callback({ success: false, message: 'Forbidden: Insufficient role' });
          return;
        }
        if (typeof content !== 'string' || content.length > MAX_CHAT_LENGTH) {
          if (callback) callback({ success: false, message: `content must be a string up to ${MAX_CHAT_LENGTH} characters` });
          return;
        }
        if (!requireJoined(sessionId, callback)) return;

        const roomName = roomFor(sessionId);
        const interventionData = {
          id: randomUUID(),
          sessionId,
          interventionType: interventionType || 'override',
          content: content.trim(),
          recruiter: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          timestamp: new Date().toISOString(),
        };

        // Broadcast intervention event to room
        io.to(roomName).emit('recruiter:intervened', interventionData);

        // Also push to chat transcript as a high-priority system intervention message
        const chatData = {
          id: randomUUID(),
          sessionId,
          message: `[Recruiter ${String(interventionType || 'Intervention').toUpperCase()}]: ${content}`,
          sender: {
            userId: user.userId,
            email: user.email,
            role: user.role,
          },
          role: user.role,
          isIntervention: true,
          timestamp: new Date().toISOString(),
        };

        io.to(roomName).emit('chat:message', chatData);

        if (callback) callback({ success: true, data: interventionData });
        console.log(`[Socket] Recruiter intervened in ${sessionId}: ${content}`);
      } catch (err: any) {
        console.error('[Socket] recruiter:intervene error:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${user?.email} (${socket.id})`);
    });
  });
}
