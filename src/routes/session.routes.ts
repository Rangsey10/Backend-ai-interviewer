import { Router } from 'express';
import * as sessionController from '../controllers/session.controller';
import { requireAuth } from '../middlewares/auth.middleware';

const router = Router();

// All session operations require valid JWT authentication
router.use(requireAuth);

// Session endpoints
router.post('/create', sessionController.create);
router.get('/:id', sessionController.getById);
router.patch('/:id/status', sessionController.updateStatus);

// Sandboxed Code Execution endpoint (Phase 4)
router.post('/:id/execute-code', sessionController.executeCodeInSession);

export default router;
