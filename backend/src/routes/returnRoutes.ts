import { Router } from 'express';
import { getReturns, processReturn } from '../controllers/returnController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticate);

router.get('/', getReturns);
router.post('/', processReturn);

export default router;
