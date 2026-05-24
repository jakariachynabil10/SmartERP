import { createClient } from 'redis';
import { env } from './env';
import { logger } from './logger';

let redisClient: any = null;
let isConnected = false;

if (env.NODE_ENV !== 'test') {
  redisClient = createClient({
    url: env.REDIS_URL,
    socket: {
      reconnectStrategy: (_retries) => {
        // Retry connection once every 10 seconds
        return 10000;
      }
    }
  });

  let lastWarnTime = 0;
  redisClient.on('error', (_err: any) => {
    const now = Date.now();
    if (isConnected || (now - lastWarnTime > 60000)) {
      logger.warn('Redis Client connection failed. Rate limiting will fallback to in-memory store.');
      lastWarnTime = now;
    }
    isConnected = false;
  });

  redisClient.on('connect', () => {
    logger.info('Connected to Redis server successfully.');
    isConnected = true;
  });

  redisClient.connect().catch((_err: any) => {
    // Already handled in error listener
  });
}

// In-Memory fallback store
const memoryStore = new Map<string, { count: number; expiresAt: number }>();

export const redis = {
  async incr(key: string, expirySeconds: number = 60): Promise<number> {
    if (isConnected && redisClient) {
      try {
        const count = await redisClient.incr(key);
        if (count === 1) {
          await redisClient.expire(key, expirySeconds);
        }
        return count;
      } catch (_err) {
        logger.debug('Redis incr failed, using memory store');
      }
    }

    // In-memory fallback logic
    const now = Date.now();
    const record = memoryStore.get(key);

    if (!record || record.expiresAt < now) {
      memoryStore.set(key, { count: 1, expiresAt: now + expirySeconds * 1000 });
      return 1;
    }

    record.count += 1;
    return record.count;
  },
  
  async get(key: string): Promise<string | null> {
    if (isConnected && redisClient) {
      try {
        return await redisClient.get(key);
      } catch (_err) {
        logger.debug('Redis get failed, using memory store');
      }
    }
    const record = memoryStore.get(key);
    if (!record || record.expiresAt < Date.now()) return null;
    return record.count.toString();
  },

  async client() {
    return redisClient;
  },

  isReady(): boolean {
    return isConnected;
  }
};

export default redis;
