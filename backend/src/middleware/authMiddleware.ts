import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { tenantStore, TenantContext } from '../config/tenantStore';
import { logger } from '../config/logger';

export interface AuthenticatedRequest extends Request {
  user?: TenantContext;
}

/**
 * Middleware to authenticate requests via JWT and bind tenant context to AsyncLocalStorage.
 */
export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Bearer token missing.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
    };

    // Run remaining middleware and handlers within the Tenant Storage context
    tenantStore.run(req.user, () => {
      next();
    });
    return;
  } catch (error) {
    logger.debug({ error }, 'JWT verification failed');
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }
}

/**
 * Optional middleware to resolve tenant from headers for unauthenticated endpoints (like login/register).
 */
export function resolveTenant(req: Request, _res: Response, next: NextFunction) {
  const tenantId = req.headers['x-tenant-id'] as string;
  
  if (tenantId) {
    const context: TenantContext = {
      tenantId,
      userId: '',
      role: '',
    };
    tenantStore.run(context, () => {
      next();
    });
  } else {
    next();
  }
}

/**
 * Middleware to gate routes by roles. Must be used AFTER authenticate middleware.
 */
export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
    }

    return next();
  };
}
