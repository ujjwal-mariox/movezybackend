import { Request, Response } from "express";
import { AppConfig } from "../../models/app-config.model";
import { Admin, AdminSession } from "../../models/admin.model";

/**
 * GET /admin/config/session
 * Get session configuration
 */
export const getSessionConfig = async (req: Request, res: Response) => {
  const config = await AppConfig.findOne({ key: "session" });

  res.locals.data = {
    config: config?.value || {
      sessionTimeoutMinutes: 480, // 8 hours default
      idleTimeoutMinutes: 15,
      maxConcurrentSessions: 3,
      enforceIPWhitelist: false,
      enforceTimeRestriction: false,
      defaultTimezone: "Asia/Kolkata",
      defaultWorkingHours: { start: 9, end: 18 },
    },
  };
};

/**
 * PUT /admin/config/session
 * Update session configuration
 */
export const updateSessionConfig = async (req: Request, res: Response) => {
  const {
    sessionTimeoutMinutes,
    idleTimeoutMinutes,
    maxConcurrentSessions,
    enforceIPWhitelist,
    enforceTimeRestriction,
    defaultTimezone,
    defaultWorkingHours,
  } = req.body;

  const config = await AppConfig.findOneAndUpdate(
    { key: "session" },
    {
      $set: {
        value: {
          sessionTimeoutMinutes: sessionTimeoutMinutes || 480,
          idleTimeoutMinutes: idleTimeoutMinutes || 15,
          maxConcurrentSessions: maxConcurrentSessions || 3,
          enforceIPWhitelist: enforceIPWhitelist || false,
          enforceTimeRestriction: enforceTimeRestriction || false,
          defaultTimezone: defaultTimezone || "Asia/Kolkata",
          defaultWorkingHours: defaultWorkingHours || { start: 9, end: 18 },
        },
        updatedBy: req.adminId,
      },
    },
    { upsert: true, new: true },
  );

  res.locals.data = {
    message: "Session configuration updated",
    config: config.value,
  };
};

/**
 * GET /admin/sessions/active
 * Get all active admin sessions
 */
export const getActiveSessions = async (req: Request, res: Response) => {
  const sessions = await AdminSession.find({
    isActive: true,
    expiresAt: { $gt: new Date() },
  })
    .populate("adminId", "fullName email roleName")
    .sort({ createdAt: -1 });

  // Group by admin
  const sessionsByAdmin = sessions.reduce((acc: any, session) => {
    const adminId = (session.adminId as any)?._id?.toString();
    if (!acc[adminId]) {
      acc[adminId] = {
        admin: session.adminId,
        sessions: [],
      };
    }
    acc[adminId].sessions.push({
      id: session._id,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
    return acc;
  }, {});

  res.locals.data = {
    total: sessions.length,
    byAdmin: Object.values(sessionsByAdmin),
  };
};

/**
 * DELETE /admin/sessions/:sessionId
 * Terminate a specific session
 */
export const terminateSession = async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const session = await AdminSession.findById(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }

  session.isActive = false;
  await session.save();

  res.locals.data = { message: "Session terminated successfully" };
};

/**
 * DELETE /admin/sessions/admin/:adminId
 * Terminate all sessions for an admin
 */
export const terminateAllAdminSessions = async (req: Request, res: Response) => {
  const { adminId } = req.params;

  const result = await AdminSession.updateMany(
    { adminId, isActive: true },
    { $set: { isActive: false } },
  );

  res.locals.data = {
    message: "All sessions terminated",
    sessionsTerminated: result.modifiedCount,
  };
};

/**
 * PUT /admin/staff/:id/session-restrictions
 * Update session restrictions for a staff member
 */
export const updateSessionRestrictions = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ipWhitelist, accessTimeRestriction } = req.body;

  const admin = await Admin.findById(id);
  if (!admin) {
    return res.status(404).json({ success: false, message: "Staff member not found" });
  }

  if (ipWhitelist !== undefined) {
    admin.ipWhitelist = ipWhitelist;
  }

  if (accessTimeRestriction !== undefined) {
    admin.accessTimeRestriction = accessTimeRestriction;
  }

  await admin.save();

  res.locals.data = {
    message: "Session restrictions updated",
    ipWhitelist: admin.ipWhitelist,
    accessTimeRestriction: admin.accessTimeRestriction,
  };
};

/**
 * GET /admin/security/login-attempts
 * Get recent login attempts (requires audit log)
 */
export const getLoginAttempts = async (req: Request, res: Response) => {
  const { page = 0, limit = 50, success } = req.query;
  const db = (await import("mongoose")).connection.db;

  if (!db) {
    res.locals.data = { attempts: [], total: 0 };
    return;
  }

  const query: any = {
    action: { $in: ["login", "login_failed", "login_success"] },
  };

  if (success !== undefined) {
    query.action = success === "true" ? "login_success" : "login_failed";
  }

  const auditLogs = db.collection("auditlogs");

  const [attempts, total] = await Promise.all([
    auditLogs
      .find(query)
      .sort({ timestamp: -1 })
      .skip(Number(page) * Number(limit))
      .limit(Number(limit))
      .toArray(),
    auditLogs.countDocuments(query),
  ]);

  res.locals.data = {
    attempts,
    total,
    page: Number(page),
    limit: Number(limit),
  };
};
