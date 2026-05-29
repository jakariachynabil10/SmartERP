import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import {
  getDashboardSummary,
  getRevenueChart,
  getProfitLoss,
  getTopProducts,
} from '../controllers/analyticsController';

const router = Router();

// Apply JWT authentication globally for all analytics routes
router.use(authenticate);

// Restrict analytics views to administrators, owners, and managers
const managerRoles = [Role.SUPER_ADMIN, Role.BUSINESS_OWNER, Role.MANAGER];
router.use(requireRole(managerRoles));

// ---------------------------------------------------------
// Analytics Endpoints
// ---------------------------------------------------------

router.get('/dashboard-summary', getDashboardSummary);
router.get('/revenue-chart', getRevenueChart);
router.get('/profit-loss', getProfitLoss);
router.get('/top-products', getTopProducts);

export default router;
