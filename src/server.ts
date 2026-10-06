import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app';
import { env, corsOrigin } from './config/env';
import { initInterviewSocket } from './sockets/interview.socket';
import { seedDevAdmin } from './services/auth.service';

const server = http.createServer(app);

// Initialize Socket.IO with CORS settings
const io = new SocketIOServer(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH'],
  },
});

// Attach real-time interview engine & room synchronization handlers
initInterviewSocket(io);

// Start HTTP + WebSocket Server
seedDevAdmin().catch((err) => console.error('Could not seed dev admin:', err));

server.listen(env.PORT, () => {
  console.log(`🚀 InterviewAI Backend running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  console.log(`🔌 Socket.IO Live Interview Session Engine initialized`);
});

export { server, io };
