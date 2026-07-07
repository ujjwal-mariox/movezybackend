import { Request, Response, NextFunction } from "express";
import { AuditLog } from "../models/audit-log.model";

// Actions that require mandatory comments
const MANDATORY_COMMENT_ACTIONS = [
  "refund:request",
  "refund:approve",
  "refund:reject",
  "driver:reject",
  "driver:suspend",
  "enterprise:reject",
  "enterprise:suspend",
  "user:block",
  "booking:cancel",
  "credit:adjust",
  "payout:reject",
];

interface CommentRequiredOptions {
  action: string;
  minLength?: number;
  maxLength?: number;
}

/**
 * Middleware to require mandatory comments for sensitive actions
 */
export const requireComment = (options: CommentRequiredOptions) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { comment, reason } = req.body;
    const commentText = comment || reason;

    if (!commentText || typeof commentText !== "string") {
      return res.status(400).json({
        success: false,
        message: `A comment/reason is required for this action: ${options.action}`,
        code: "COMMENT_REQUIRED",
      });
    }

    const trimmedComment = commentText.trim();
    const minLength = options.minLength || 10;
    const maxLength = options.maxLength || 1000;

    if (trimmedComment.length < minLength) {
      return res.status(400).json({
        success: false,
        message: `Comment must be at least ${minLength} characters long`,
        code: "COMMENT_TOO_SHORT",
      });
    }

    if (trimmedComment.length > maxLength) {
      return res.status(400).json({
        success: false,
        message: `Comment cannot exceed ${maxLength} characters`,
        code: "COMMENT_TOO_LONG",
      });
    }

    // Attach validated comment to request for later use
    req.body._validatedComment = trimmedComment;
    next();
  };
};

/**
 * Middleware to audit log sensitive actions with comments
 */
export const auditAction = (action: string, resourceType: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Store original res.json to intercept response
    const originalJson = res.json.bind(res);

    res.json = (data: any) => {
      // Only log if response was successful
      if (data?.success !== false && res.statusCode < 400) {
        const logEntry = {
          adminId: req.adminId,
          action,
          resourceType,
          resourceId: req.params.id || data?.data?.id || data?.data?._id,
          details: {
            comment: req.body._validatedComment || req.body.comment || req.body.reason,
            requestBody: sanitizeRequestBody(req.body),
            ip: req.ip || req.socket.remoteAddress,
            userAgent: req.headers["user-agent"],
          },
          timestamp: new Date(),
        };

        // Fire and forget - don't block response
        AuditLog.create(logEntry).catch((err: Error) => {
          console.error("[AuditLog] Failed to create audit log:", err);
        });
      }

      return originalJson(data);
    };

    next();
  };
};

/**
 * Remove sensitive fields from request body before logging
 */
function sanitizeRequestBody(body: any): any {
  const sanitized = { ...body };
  const sensitiveFields = [
    "password",
    "token",
    "secret",
    "apiKey",
    "creditCard",
    "cvv",
    "_validatedComment",
  ];

  sensitiveFields.forEach((field) => {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  });

  return sanitized;
}

/**
 * Combined middleware for requiring comment and auditing
 */
export const requireCommentAndAudit = (
  action: string,
  resourceType: string,
  options?: { minLength?: number; maxLength?: number },
) => {
  return [
    requireComment({ action, ...options }),
    auditAction(action, resourceType),
  ];
};

export default {
  requireComment,
  auditAction,
  requireCommentAndAudit,
  MANDATORY_COMMENT_ACTIONS,
};
