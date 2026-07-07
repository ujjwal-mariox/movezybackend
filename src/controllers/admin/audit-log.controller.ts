import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuditLog, deriveImpactLevel } from "../../models/audit-log.model";

// Helper to create audit log entries (used by other controllers)
export const createAuditEntry = async (data: {
  adminId: string;
  adminName: string;
  adminEmail: string;
  adminRole?: string;
  action: string;
  module: string;
  targetId?: string;
  targetType?: string;
  description: string;
  changes?: { field: string; oldValue: any; newValue: any }[];
  before?: Record<string, any>;
  after?: Record<string, any>;
  impactLevel?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  device?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
  revertedFromId?: string;
}) => {
  try {
    await AuditLog.create({
      ...data,
      impactLevel: data.impactLevel || deriveImpactLevel(data.action),
      revertedFromId: data.revertedFromId
        ? new Types.ObjectId(data.revertedFromId)
        : undefined,
    });
  } catch (err) {
    console.error("[AuditLog] Failed to create entry:", err);
  }
};

// GET /admin/audit-logs
export const getAuditLogs = async (req: Request, res: Response) => {
  const {
    page = 1,
    limit = 50,
    module,
    action,
    adminId,
    impactLevel,
    startDate,
    endDate,
    search,
  } = req.query;

  const filter: any = {};
  if (module) filter.module = module;
  if (action) filter.action = action;
  if (adminId) filter.adminId = adminId;
  if (impactLevel) filter.impactLevel = impactLevel;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate as string);
    if (endDate) filter.createdAt.$lte = new Date(endDate as string);
  }
  if (search) {
    filter.$or = [
      { description: { $regex: search, $options: "i" } },
      { adminName: { $regex: search, $options: "i" } },
      { adminEmail: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  // Back-fill impactLevel on legacy docs so the UI always has it
  const enriched = logs.map((l: any) => ({
    ...l,
    impactLevel: l.impactLevel || deriveImpactLevel(l.action),
  }));

  res.locals.data = {
    logs: enriched,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// GET /admin/audit-logs/stats
export const getAuditStats = async (req: Request, res: Response) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalToday,
    byModule,
    byAction,
    byImpact,
    criticalToday,
    recentExports,
  ] = await Promise.all([
    AuditLog.countDocuments({ createdAt: { $gte: today } }),
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: "$module", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: "$action", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: "$impactLevel", count: { $sum: 1 } } },
    ]),
    AuditLog.countDocuments({
      createdAt: { $gte: today },
      $or: [
        { impactLevel: "CRITICAL" },
        { action: { $in: ["DELETE", "BLOCK", "CONFIG_CHANGE", "REFUND", "RESET_PASSWORD"] } },
      ],
    }),
    AuditLog.find({ action: "EXPORT" })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  res.locals.data = {
    totalToday,
    criticalToday,
    byModule,
    byAction,
    byImpact,
    recentExports,
  };
};

// POST /admin/audit-logs/:id/revert
export const revertAuditLog = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;
  const original = await AuditLog.findById(id);
  if (!original) {
    res.locals.data = { success: false, message: "Audit log not found" };
    return;
  }
  if (original.revertedAt) {
    res.locals.data = {
      success: false,
      message: "This action has already been reverted",
    };
    return;
  }
  const revertable = ["UPDATE", "DELETE", "BLOCK", "CONFIG_CHANGE", "CHANGE_ROLE", "CHANGE_STATUS"];
  if (!revertable.includes(original.action)) {
    res.locals.data = {
      success: false,
      message: `Action ${original.action} is not revertable`,
    };
    return;
  }

  const compensating = await AuditLog.create({
    adminId: req.adminId,
    adminName: (req as any).adminName || "Admin",
    adminEmail: (req as any).adminEmail || "",
    adminRole: (req as any).adminRole,
    action: "CONFIG_CHANGE",
    module: original.module,
    targetId: original.targetId,
    targetType: original.targetType,
    description: `Revert of ${original.action}: ${original.description}`,
    before: original.after,
    after: original.before,
    impactLevel: "HIGH",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    revertedFromId: original._id,
    metadata: {
      revertReason: reason,
      originalAuditId: original._id,
      originalAction: original.action,
    },
  });

  original.revertedAt = new Date();
  original.revertedBy = req.adminId ? new Types.ObjectId(req.adminId) : undefined;
  await original.save();

  res.locals.data = {
    success: true,
    message: "Compensating audit entry created. Apply the reverted state manually if required.",
    data: { compensating, originalId: original._id },
  };
};
