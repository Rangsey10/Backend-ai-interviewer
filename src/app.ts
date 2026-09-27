import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsOrigin } from './config/env';
import { errorHandler } from './middlewares/errorHandler';
import authRoutes from './routes/auth.routes';
import testRoutes from './routes/test.routes';
import sessionRoutes from './routes/session.routes';

const app: Application = express();

app.use(helmet());
// Auth uses Bearer tokens (not cookies), so credentialed CORS is not needed
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'interviewai-backend',
    timestamp: new Date().toISOString(),
  });
});

// Authentication & Authorization Routes
app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);

// Interview Session Management Routes (Phase 3)
app.use('/sessions', sessionRoutes);
app.use('/api/sessions', sessionRoutes);

// Test Verification Routes for JWT & RBAC (Phase 2)
app.use('/api/test', testRoutes);

// Global Error Handler
app.use(errorHandler);

export default app;
