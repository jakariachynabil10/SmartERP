import { Request, Response } from 'express';
import { prisma } from '../config/prismaClient';
import { logger } from '../config/logger';

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const { action, module, page = '1', limit = '50' } = req.query;
    const pNum = parseInt(page as string);
    const lNum = parseInt(limit as string);
    const skip = (pNum - 1) * lNum;

    const where: any = {};
    if (action) where.action = action as string;
    if (module) where.module = module as string;

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
        pages: Math.ceil(total / lNum),
        page: pNum,
        limit: lNum,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch audit logs');
    return res.status(500).json({ error: 'Failed to fetch audit logs.' });
  }
};
