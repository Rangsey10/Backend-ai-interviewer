import { Router } from 'express';
import * as sessionController from '../controllers/session.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { handle } from '../lib/handler';
import * as platform from '../controllers/platform.controller';

const router = Router();

// All session operations require valid JWT authentication
router.use(requireAuth);

// Session endpoints
router.get('/', handle(platform.listSessions));
router.post('/create', sessionController.create);
router.get('/:id', sessionController.getById);
router.get('/:id/questions', handle(platform.sessionQuestions));
router.put('/:id/questions', handle(platform.saveSessionQuestions));
router.get('/:id/report', handle(platform.sessionReport));
router.patch('/:id/status', sessionController.updateStatus);

// Sandboxed Code Execution endpoint (Phase 4)
router.post('/:id/execute-code', sessionController.executeCodeInSession);

export default router;
