import { Router } from 'express';
import { getAuditLogs } from '../controllers/auditController';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { Role } from '@prisma/client';

const router = Router();

router.get(
  '/',
  authenticate,
  requireRole([Role.BUSINESS_OWNER, Role.MANAGER, Role.SUPER_ADMIN]),
  getAuditLogs
);

export default router;
