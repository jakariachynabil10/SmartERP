import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { verifyAccessToken } from '../utils/jwt';

// Limits defined as requests per minute
const LIMITS = {
  FREE: 60,
  PRO: 300,
  ENTERPRISE: 1000,
  GLOBAL: 100, // For unauthenticated requests (by IP)
};

function resolveAuthContext(req: Request) {
  const fromStore = tenantStore.getStore();
  if (fromStore?.tenantId) {
    return { tenantId: fromStore.tenantId, role: fromStore.role };
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(authHeader.split(' ')[1]);
      return { tenantId: payload.tenantId, role: payload.role };
    } catch {
      return null;
    }
  }

  return null;
}

export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  if (env.NODE_ENV === 'development') {
    return next();
  }

  const authContext = resolveAuthContext(req);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  let key = '';
  let limit = LIMITS.GLOBAL;

  if (authContext?.tenantId) {
    const role = authContext.role;
    const isOwner = role === 'BUSINESS_OWNER';
    const isSuper = role === 'SUPER_ADMIN';

    limit = isSuper ? LIMITS.ENTERPRISE : isOwner ? LIMITS.PRO : LIMITS.FREE;
    key = `rate:tenant:${authContext.tenantId}:${new Date().getMinutes()}`;
  } else {
    limit = LIMITS.GLOBAL;
    key = `rate:ip:${ip}:${new Date().getMinutes()}`;
  }

  try {
    const count = await redis.incr(key, 60);

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));

    if (count > limit) {
      logger.warn({ key, count, limit }, 'Rate limit exceeded');
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
      });
    }

    return next();
  } catch (error) {
    logger.error({ error }, 'Rate limiter failure');
    return next(); // Degrade gracefully, don't block user requests on rate limiter bugs
  }
}
