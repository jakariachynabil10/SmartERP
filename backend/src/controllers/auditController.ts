import { Request, Response } from 'express';
import { prisma } from '../config/prismaClient';
import { logger } from '../config/logger';
import { getTenantContext, runWithBypass } from '../config/tenantScope';

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const context = getTenantContext();
    if (!context?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized context.' });
    }

    const { action, module, page = '1', limit = '50' } = req.query;
    const pNum = parseInt(page as string, 10);
    const lNum = parseInt(limit as string, 10);
    const skip = (pNum - 1) * lNum;

    const isSuperAdmin = context.role === 'SUPER_ADMIN';

    const fetchLogs = async () => {
      const where: Record<string, string> = {};
      if (action) where.action = action as string;
      if (module) where.module = module as string;

      // Regular tenants: only their audit trail (also enforced in Prisma extension)
      if (!isSuperAdmin) {
        where.tenantId = context.tenantId;
      }

      const [logs, total] = await prisma.$transaction([
        prisma.auditLog.findMany({
          where,
          skip,
          take: lNum,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.auditLog.count({ where }),
      ]);

      return res.json({
        logs,
        pagination: {
          total,
          pages: Math.ceil(total / lNum) || 1,
          page: pNum,
          limit: lNum,
        },
      });
    };

    // Super admin may view audit logs across all tenants
    if (isSuperAdmin) {
      return runWithBypass(fetchLogs);
    }

    return fetchLogs();
  } catch (error) {
    logger.error({ error }, 'Failed to fetch audit logs');
    return res.status(500).json({ error: 'Failed to fetch audit logs.' });
  }
};
