import { Request, Response, NextFunction } from "express";
import { rateLimiter } from "../utils/redis.util";

interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
  keyPrefix?: string;
  keyGenerator?: (req: Request) => string;
  message?: string;
  skipFailedRequests?: boolean;
}

/**
 * Rate limiting middleware using Redis
 */
export const rateLimit = (options: RateLimitOptions) => {
  const {
    windowSeconds,
    maxRequests,
    keyPrefix = "rl",
    keyGenerator,
    message = "Too many requests, please try again later",
    skipFailedRequests = false,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Generate key for rate limiting
      let key: string;
      if (keyGenerator) {
        key = keyGenerator(req);
      } else {
        // Use IP + path as default key
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        key = `${keyPrefix}:${ip}:${req.path}`;
      }

      const result = await rateLimiter.isAllowed(
        key,
        maxRequests,
        windowSeconds,
      );

      // Add rate limit headers
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", result.remaining);
      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil(Date.now() / 1000) + result.resetIn,
      );

      if (!result.allowed) {
        res.setHeader("Retry-After", result.resetIn);
        return res.status(429).json({
          success: false,
          message,
          retryAfter: result.resetIn,
        });
      }

      next();
    } catch (error) {
      console.error("Rate limiter error:", error);
      // If Redis fails, allow the request to proceed
      next();
    }
  };
};

/**
 * Predefined rate limiters
 */
export const rateLimiters = {
  // General API rate limit: 100 requests per minute
  general: rateLimit({
    windowSeconds: 60,
    maxRequests: 100,
    keyPrefix: "rl:general",
  }),

  // Auth endpoints: 5 requests per minute
  auth: rateLimit({
    windowSeconds: 60,
    maxRequests: 5,
    keyPrefix: "rl:auth",
    message: "Too many login attempts. Please try again in a minute.",
  }),

  // OTP endpoints: 3 requests per 5 minutes
  otp: rateLimit({
    windowSeconds: 300,
    maxRequests: 3,
    keyPrefix: "rl:otp",
    message: "Too many OTP requests. Please wait 5 minutes.",
  }),

  // Booking creation: 10 per minute
  booking: rateLimit({
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: "rl:booking",
  }),

  // Search/heavy endpoints: 30 per minute
  search: rateLimit({
    windowSeconds: 60,
    maxRequests: 30,
    keyPrefix: "rl:search",
  }),

  // File upload: 10 per minute
  upload: rateLimit({
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: "rl:upload",
  }),

  // Admin endpoints: 200 per minute
  admin: rateLimit({
    windowSeconds: 60,
    maxRequests: 200,
    keyPrefix: "rl:admin",
  }),
};

export default rateLimiters;
