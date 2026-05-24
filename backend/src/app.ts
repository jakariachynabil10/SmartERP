import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { prisma } from './config/prismaClient';
import { redis } from './config/redis';
import { rateLimiter } from './middleware/rateLimiter';
import authRoutes from './routes/authRoutes';
import inventoryRoutes from './routes/inventoryRoutes';
import warehouseRoutes from './routes/warehouseRoutes';
import customerRoutes from './routes/customerRoutes';
import posRoutes from './routes/posRoutes';
import returnRoutes from './routes/returnRoutes';
import supplierRoutes from './routes/supplierRoutes';
import auditRoutes from './routes/auditRoutes';
import { logger } from './config/logger';

const app = express();

// Security and utility Middlewares
app.use(helmet());
app.use(cors({
  origin: '*', // Adjust to specific frontend domain in production
  credentials: true,
}));
app.use(express.json());

// Apply global rate limiting to all API calls
app.use('/api', rateLimiter);

// Liveness check
app.get('/health', async (_req, res) => {
  try {
    // Basic DB check
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: 'UP', timestamp: new Date() });
  } catch (err) {
    logger.error({ err }, 'Liveness check failed');
    return res.status(500).json({ status: 'DOWN', database: 'DISCONNECTED' });
  }
});

// Readiness check (Redis check)
app.get('/ready', (_req, res) => {
  const redisReady = redis.isReady();
  if (redisReady || process.env.NODE_ENV === 'development') {
    return res.json({
      status: 'READY',
      redis: redisReady ? 'CONNECTED' : 'DISCONNECTED (fallback active)',
    });
  }
  return res.status(503).json({ status: 'NOT_READY', redis: 'DISCONNECTED' });
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/warehouses', warehouseRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/pos', posRoutes);
app.use('/api/v1/returns', returnRoutes);
app.use('/api/v1/suppliers', supplierRoutes);
app.use('/api/v1/audit', auditRoutes);

// Global Error Handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled request error');
  return res.status(500).json({
    error: 'Internal server error. Please contact administrator.',
  });
});

export default app;
