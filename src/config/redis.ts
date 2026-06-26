import { createClient } from 'redis';
import config from './index';

type RedisClient = ReturnType<typeof createClient>;

/**
 * Shared connection options. The bounded `reconnectStrategy` is critical:
 * node-redis retries forever by default, so a `.connect()` against a down
 * Redis NEVER rejects and would hang server boot indefinitely. We instead
 * give up after a handful of quick attempts (returning an Error stops the
 * client and rejects `.connect()`), letting callers fall back to in-memory.
 * The data client then self-heals — the next call opens a fresh connection.
 */
export const redisSocketOptions = {
  connectTimeout: 10_000,
  reconnectStrategy: (retries: number): number | Error =>
    retries > 8
      ? new Error('redis: giving up after 8 reconnect attempts')
      : Math.min(retries * 100, 1000),
};

let client: RedisClient | null = null;
let connecting: Promise<RedisClient | null> | null = null;

/**
 * True when REDIS_ENABLED=true — i.e. this deployment shares state across
 * instances via Redis. When false, the app uses in-process memory and no
 * Redis connection is ever opened.
 */
export function isRedisEnabled(): boolean {
  return config.redis.enabled;
}

/**
 * Lazily connect (once) and return a shared Redis client for ordinary data
 * commands — currently the cross-instance ride-dispatch set used to dismiss
 * losing drivers' request modals.
 *
 * Returns `null` when Redis is disabled or unreachable, so every caller can
 * transparently fall back to in-memory state. A failed connect doesn't throw
 * and doesn't cache the failure permanently: the next call retries, so the
 * app self-heals once Redis comes back.
 *
 * NOTE: this is intentionally separate from the Socket.IO adapter's own
 * pub/sub clients (see `initSocketRedisAdapter` in socket/index.ts) — node-
 * redis requires dedicated connections for pub/sub vs. regular commands.
 */
export async function getRedis(): Promise<RedisClient | null> {
  if (!config.redis.enabled) return null;
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = createClient({ url: config.redis.url, socket: redisSocketOptions });
      c.on('error', (err) =>
        console.warn('[redis] client error:', (err as Error)?.message ?? err),
      );
      await c.connect();
      client = c;
      console.log('[redis] data client connected:', config.redis.url);
      return client;
    } catch (err) {
      console.warn(
        '[redis] connect failed — falling back to in-memory state:',
        (err as Error)?.message ?? err,
      );
      connecting = null;
      return null;
    }
  })();

  return connecting;
}
