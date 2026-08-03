import { Request, Response, NextFunction } from "express";
import { auditFromRequest } from "../controllers/admin/audit-log.controller";

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
 * The granular action strings this middleware is wired with ("refund:approve_l1",
 * "cod:settle", …) are NOT values of the AuditLog `action` enum, and the schema
 * also requires adminName, adminEmail, module and description. The old raw
 * AuditLog.create({ adminId, action, resourceType, resourceId, details,
 * timestamp }) therefore threw a ValidationError on EVERY call, which the
 * `.catch` logged and swallowed — so refund approvals and COD settlements
 * produced no audit row at all. Map to a valid enum action + module here and
 * keep the granular string in metadata.
 */
const AUDIT_ACTION_MAP: Record<string, { action: string; module: string }> = {
  "refund:request": { action: "CREATE", module: "payments" },
  "refund:approve": { action: "APPROVE", module: "payments" },
  "refund:approve_l1": { action: "APPROVE", module: "payments" },
  "refund:approve_l2": { action: "APPROVE", module: "payments" },
  "refund:reject": { action: "REJECT", module: "payments" },
  "payout:reject": { action: "REJECT", module: "payments" },
  "cod:settle": { action: "UPDATE", module: "payments" },
  "credit:adjust": { action: "UPDATE", module: "enterprises" },
  "credit:update_limit": { action: "UPDATE", module: "enterprises" },
  "driver:reject": { action: "REJECT", module: "drivers" },
  "driver:suspend": { action: "SUSPEND", module: "drivers" },
  "enterprise:reject": { action: "REJECT", module: "enterprises" },
  "enterprise:suspend": { action: "SUSPEND", module: "enterprises" },
  "user:block": { action: "BLOCK", module: "users" },
  "booking:cancel": { action: "UPDATE", module: "bookings" },
};

/**
 * Middleware to audit log sensitive actions with comments
 */
export const auditAction = (action: string, resourceType: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Store original res.json to intercept response
    const originalJson = res.json.bind(res);

    res.json = (data: any) => {
      // Only log if response was successful. Note the routes here answer through
      // ResponseMiddleware as { code, message, data }, where code 0/3/4/5 also
      // set a 4xx status — hence the statusCode check.
      if (data?.success !== false && res.statusCode < 400) {
        const mapped = AUDIT_ACTION_MAP[action] || {
          action: "UPDATE",
          module: "payments",
        };
        const comment =
          req.body._validatedComment || req.body.comment || req.body.reason;

        // Fire and forget — auditFromRequest never throws.
        void auditFromRequest(req, {
          action: mapped.action,
          module: mapped.module,
          targetId: String(
            req.params.id || data?.data?.id || data?.data?._id || "",
          ),
          targetType: resourceType,
          description: `${action} on ${resourceType}${comment ? ` — ${comment}` : ""}`,
          metadata: {
            granularAction: action,
            comment,
            requestBody: sanitizeRequestBody(req.body),
          },
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
