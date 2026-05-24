import http from 'http';
import { Server } from 'socket.io';
import app from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { setupRowLevelSecurity } from './config/setupRls';

const port = env.PORT || 5000;
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  logger.info(`Websocket client connected: ${socket.id}`);
  
  // Listen for tenant registration to join room
  socket.on('join-tenant-room', (tenantId: string) => {
    socket.join(tenantId);
    logger.info(`Socket ${socket.id} joined room for tenant: ${tenantId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`Websocket client disconnected: ${socket.id}`);
  });
});

// Export notification emitter helper
export const notifyTenant = (tenantId: string, event: string, data: any) => {
  io.to(tenantId).emit(event, data);
};

async function startServer() {
  try {
    // 1. Run Row-Level Security checks and setup on Postgres
    if (env.NODE_ENV !== 'test') {
      await setupRowLevelSecurity();
    }

    // 2. Start HTTP + WS listener
    server.listen(port, () => {
      logger.info(`SmartERP API Server is running in ${env.NODE_ENV} mode on port ${port}`);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database or start API server');
    process.exit(1);
  }
}

// Graceful Shutdown
const shutdown = () => {
  logger.info('Shutting down API server gracefully...');
  server.close(() => {
    logger.info('API server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startServer();
