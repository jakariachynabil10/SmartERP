import { Router } from 'express';
import { checkout, syncOfflineSales } from '../controllers/posController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticate);

router.post('/checkout', checkout);
router.post('/sync', syncOfflineSales);

export default router;
