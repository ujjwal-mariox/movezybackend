import { createClient, RedisClientType } from "redis";
import config from "../config";

let client: RedisClientType | null = null;

// One warning per outage rather than one per call: the delay-detection sweep
// alone hit a closed client several times a minute and buried everything else.
// Reset when Redis reconnects, so the next outage is reported again.
let warnedUnavailable = false;

/**
 * Initialize Redis connection
 */
export const initRedis = async (): Promise<RedisClientType> => {
  if (client) return client;

  client = createClient({
    url: config.redis.url,
    socket: {
      // Never stop trying. Returning an Error here makes node-redis abandon the
      // connection permanently, so a transient DNS failure or a brief Upstash
      // blip disabled the cache for the entire lifetime of the process — it
      // only ever came back with a redeploy. A cache should reconnect forever;
      // the callers degrade gracefully in the meantime.
      reconnectStrategy: (retries) => Math.min(retries * 200, 30_000),
    },
  });

  // node-redis emits 'error' on every failed reconnect attempt. Unthrottled that
  // is a line every few seconds forever, which buried real errors in the log.
  let lastErrorLoggedAt = 0;
  client.on("error", (err) => {
    const now = Date.now();
    if (now - lastErrorLoggedAt > 60_000) {
      lastErrorLoggedAt = now;
      console.error("Redis Client Error (throttled to 1/min):", err?.message || err);
    }
  });
  client.on("connect", () => {
    warnedUnavailable = false; // let the next outage warn again
    console.log("Redis: Connected");
  });
  client.on("reconnecting", () => {});

  // Do not let a dead cache block startup. connect() rejects when the host does
  // not resolve, which took the whole API down over an optional dependency.
  try {
    await client.connect();
  } catch (err) {
    console.warn(
      "Redis: initial connect failed — starting without a cache and retrying in the background.",
      err instanceof Error ? err.message : err,
    );
  }
  return client;
};

/**
 * Get Redis client
 */
export const getRedisClient = (): RedisClientType => {
  if (!client) {
    throw new Error("Redis client not initialized. Call initRedis first.");
  }
  return client;
};

/**
 * Duplicate the client for a dedicated connection (pub/sub, the Socket.io
 * adapter — these cannot share the command connection).
 *
 * ALWAYS use this rather than calling .duplicate() directly. A duplicate does
 * NOT inherit the parent's listeners, so an unhandled 'error' event is emitted
 * as a bare EventEmitter error — node-redis prints "missing 'error' handler on
 * this Redis client", and on an unhandled 'error' Node can terminate the
 * process. That stayed hidden while the reconnect strategy gave up after ten
 * attempts; now that it retries indefinitely, a duplicate without a handler
 * would emit forever.
 */
export const duplicateRedisClient = (label: string): RedisClientType => {
  const dup = getRedisClient().duplicate();
  let lastLoggedAt = 0;
  dup.on("error", (err) => {
    const now = Date.now();
    if (now - lastLoggedAt > 60_000) {
      lastLoggedAt = now;
      console.error(
        `Redis (${label}) error (throttled to 1/min):`,
        err?.message || err,
      );
    }
  });
  return dup as RedisClientType;
};

/**
 * Is Redis usable right now? A client that has never been initialised, or whose
 * socket has closed, is not.
 */
const redisReady = (): boolean => !!client && client.isOpen;

const noteUnavailable = (op: string, err?: unknown) => {
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    console.warn(
      `Redis unavailable (${op}) — cache reads will miss and cache writes are skipped ` +
        `until it reconnects. This degrades performance, not correctness.`,
      err instanceof Error ? err.message : "",
    );
  }
};

/**
 * Cache utilities.
 *
 * These treat Redis as what it is — a cache. A closed or erroring client means a
 * MISS (reads) or a NO-OP (writes), never an exception. Previously every method
 * called getRedisClient() and used it straight away, so losing Redis threw
 * ClientClosedError out of the vehicle-type, addon, goods-type, cancellation-
 * reason and prohibited-item endpoints — the customer app's entire booking
 * catalogue — and out of every admin config save, which had already written to
 * Mongo and so reported failure for a change that had actually been applied.
 *
 * `incr` is deliberately NOT in here: a counter is not a cache, and silently
 * returning a stale or restarted sequence is worse than failing. See
 * booking-number.service.ts, which no longer uses Redis at all.
 */
export const cache = {
  /**
   * Get cached value. Returns null on a miss AND when Redis is unavailable.
   */
  async get<T>(key: string): Promise<T | null> {
    if (!redisReady()) {
      noteUnavailable("get");
      return null;
    }
    try {
      const value = await client!.get(key);
      if (!value) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as unknown as T;
      }
    } catch (err) {
      noteUnavailable("get", err);
      return null;
    }
  },

  /**
   * Set cached value with optional TTL (in seconds). No-op if Redis is down.
   */
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    if (!redisReady()) {
      noteUnavailable("set");
      return;
    }
    try {
      const stringValue =
        typeof value === "string" ? value : JSON.stringify(value);
      if (ttlSeconds) {
        await client!.setEx(key, ttlSeconds, stringValue);
      } else {
        await client!.set(key, stringValue);
      }
    } catch (err) {
      noteUnavailable("set", err);
    }
  },

  /**
   * Delete cached value. A failed invalidation is safe: the entry still expires
   * on its TTL, and the caller has already written the authoritative row.
   */
  async del(key: string): Promise<void> {
    if (!redisReady()) {
      noteUnavailable("del");
      return;
    }
    try {
      await client!.del(key);
    } catch (err) {
      noteUnavailable("del", err);
    }
  },

  /**
   * Delete multiple keys by pattern using SCAN (non-blocking)
   */
  async delPattern(pattern: string): Promise<void> {
    if (!redisReady()) {
      noteUnavailable("delPattern");
      return;
    }
    try {
      let cursor: string = "0";
      do {
        const result = await client!.scan(cursor, {
          MATCH: pattern,
          COUNT: 100,
        });
        cursor = result.cursor.toString();
        if (result.keys.length > 0) {
          await client!.del(result.keys);
        }
      } while (cursor !== "0");
    } catch (err) {
      noteUnavailable("delPattern", err);
    }
  },

  /**
   * Check if key exists. False when Redis is unavailable — callers must treat
   * this as "not cached", never as "confirmed absent".
   */
  async exists(key: string): Promise<boolean> {
    if (!redisReady()) {
      noteUnavailable("exists");
      return false;
    }
    try {
      return (await client!.exists(key)) === 1;
    } catch (err) {
      noteUnavailable("exists", err);
      return false;
    }
  },

  /**
   * Set expiry on existing key
   */
  async expire(key: string, seconds: number): Promise<void> {
    if (!redisReady()) {
      noteUnavailable("expire");
      return;
    }
    try {
      await client!.expire(key, seconds);
    } catch (err) {
      noteUnavailable("expire", err);
    }
  },
};

/**
 * In-memory fallback counter store, used only when Redis is unavailable.
 * Bounded fixed-window counters keyed by identifier. This keeps rate limiting
 * functional (fail-safe, NOT fail-open) without taking the whole API down if
 * Redis dies. Not shared across instances, but always enforces a limit.
 */
const inMemoryCounters = new Map<string, { count: number; resetAt: number }>();

const inMemoryIsAllowed = (
  identifier: string,
  maxRequests: number,
  windowSeconds: number
): { allowed: boolean; remaining: number; resetIn: number } => {
  const now = Date.now();
  const key = `ratelimit:${identifier}`;
  const entry = inMemoryCounters.get(key);

  // Opportunistically evict expired entries to bound memory growth.
  if (inMemoryCounters.size > 10000) {
    for (const [k, v] of inMemoryCounters) {
      if (v.resetAt <= now) inMemoryCounters.delete(k);
    }
  }

  if (!entry || entry.resetAt <= now) {
    inMemoryCounters.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: maxRequests - 1, resetIn: windowSeconds };
  }

  entry.count += 1;
  const resetIn = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    allowed: entry.count <= maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetIn,
  };
};

/**
 * Rate limiter using Redis, with an in-memory fail-safe fallback.
 */
export const rateLimiter = {
  /**
   * Check if request is allowed
   * @returns true if allowed, false if rate limited
   */
  async isAllowed(
    identifier: string,
    maxRequests: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
    const redis = getRedisClient();
    // Fail safe (not fail open): if Redis is down, still enforce a limit
    // using the bounded in-memory counter instead of allowing everything.
    if (!redis.isOpen) {
      return inMemoryIsAllowed(identifier, maxRequests, windowSeconds);
    }

    const key = `ratelimit:${identifier}`;
    try {
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      const ttl = await redis.ttl(key);
      const allowed = current <= maxRequests;
      const remaining = Math.max(0, maxRequests - current);

      return {
        allowed,
        remaining,
        resetIn: ttl > 0 ? ttl : windowSeconds,
      };
    } catch (error) {
      console.warn("Rate limiter: Redis error, using in-memory fallback");
      return inMemoryIsAllowed(identifier, maxRequests, windowSeconds);
    }
  },
};

/**
 * Session store using Redis
 */
export const sessionStore = {
  async set(sessionId: string, data: any, ttlSeconds = 86400): Promise<void> {
    await cache.set(`session:${sessionId}`, data, ttlSeconds);
  },

  async get<T>(sessionId: string): Promise<T | null> {
    return await cache.get<T>(`session:${sessionId}`);
  },

  async delete(sessionId: string): Promise<void> {
    await cache.del(`session:${sessionId}`);
  },

  async extend(sessionId: string, ttlSeconds = 86400): Promise<void> {
    await cache.expire(`session:${sessionId}`, ttlSeconds);
  },
};

/**
 * Pub/Sub for real-time updates
 */
export const pubsub = {
  async publish(channel: string, message: any): Promise<void> {
    const redis = getRedisClient();
    await redis.publish(channel, JSON.stringify(message));
  },

  async subscribe(
    channel: string,
    callback: (message: any) => void
  ): Promise<void> {
    const subscriber = duplicateRedisClient(`subscribe:${channel}`);
    await subscriber.connect();
    
    await subscriber.subscribe(channel, (message) => {
      try {
        callback(JSON.parse(message));
      } catch {
        callback(message);
      }
    });
  },
};

export default {
  initRedis,
  getRedisClient,
  cache,
  rateLimiter,
  sessionStore,
  pubsub,
};
