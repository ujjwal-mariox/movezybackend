/**
 * Legacy Redis helper.
 *
 * This module previously created its OWN Redis connection, duplicating the one
 * in redis.util.ts (two TCP connections to the same server). It now delegates
 * to the single shared client from redis.util.ts so there is exactly one
 * connection process-wide.
 *
 * The public API (SetRedis / GetKeys / GetKeyRedis / GetRedis) and its exact
 * return shapes are preserved byte-for-byte so existing call sites — notably the
 * OTP login flow in auth.controller.ts, driver-auth.controller.ts and
 * user.service.ts — behave identically. Prefer importing { cache } from
 * redis.util.ts directly in new code.
 */
import { getRedisClient } from "./redis.util";

export default function redis() {
  // Resolve the shared client lazily, on each call, exactly like the old code
  // resolved its own client lazily. initRedis() (called at server startup in
  // server.ts) must have run first — same precondition as before.
  const getClient = () => getRedisClient();

  const SetRedis = async (
    key: string,
    val: unknown,
    expireTime?: number
  ): Promise<string> => {
    const redisClient = getClient();
    if (!redisClient.isOpen) {
      throw new Error("Redis client is not connected");
    }

    await redisClient.set(key, JSON.stringify(val));

    if (expireTime) {
      await redisClient.expire(key, expireTime);
    }

    return "Value set in Redis";
  };

  const GetKeys = async (key: string): Promise<string[]> => {
    const redisClient = getClient();
    if (!redisClient.isOpen) {
      throw new Error("Redis client is not connected");
    }

    const exists = await redisClient.exists(key);
    return exists ? [key] : [];
  };

  const GetKeyRedis = async <T = unknown>(key: string): Promise<T | false> => {
    const redisClient = getClient();
    if (!redisClient.isOpen) return false;

    const reply = await redisClient.get(key);
    return reply ? (JSON.parse(reply) as T) : false;
  };

  const GetRedis = async <T = unknown>(key: string): Promise<T[]> => {
    const redisClient = getClient();
    if (!redisClient.isOpen) {
      throw new Error("Redis client is not connected");
    }

    const reply = await redisClient.mGet([key]);
    return reply
      .filter(Boolean)
      .map((v: string | null) => JSON.parse(v as string)) as T[];
  };

  return {
    SetRedis,
    GetKeys,
    GetKeyRedis,
    GetRedis,
  };
}
