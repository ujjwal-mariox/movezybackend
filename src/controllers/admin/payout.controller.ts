import { Request, Response } from "express";
import Payout from "../../models/payout.model";
import Driver from "../../models/driver.model";
import { createAuditEntry } from "./audit-log.controller";

// Acting admin identity off the request (set by admin-auth middleware).
const actingAdmin = (req: Request) => {
  const a = (req as any).admin || {};
  return {
    adminId: (req as any).adminId || String(a._id || ""),
    adminName: a.name || a.fullName || "Admin",
    adminEmail: a.email || "",
    adminRole: a.roleName || a.role,
  };
};

const audit = (
  req: Request,
  action: string,
  payout: any,
  description: string,
) =>
  createAuditEntry({
    ...actingAdmin(req),
    action,
    module: "payments",
    targetId: String(payout._id),
    targetType: "Payout",
    description,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

/**
 * POST /admin/finance/payouts
 * Create a manual payout request for a driver (status PENDING).
 */
export const createPayout = async (req: Request, res: Response) => {
  const { driverId, amount, method, notes } = req.body;

  const amt = Number(amount);
  if (!driverId || !amt || amt <= 0) {
    return res.status(400).json({
      success: false,
      message: "driverId and a positive amount are required",
    });
  }

  const driver = await Driver.findById(driverId).select(
    "fullName mobileNumber bankDetails",
  );
  if (!driver) {
    return res.status(404).json({ success: false, message: "Driver not found" });
  }

  const bank = (driver as any).bankDetails || {};
  const payout = await Payout.create({
    driverId,
    amount: amt,
    method: method || "BANK",
    status: "PENDING",
    notes,
    bankSnapshot: {
      accountHolderName: bank.accountHolderName,
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      ifscCode: bank.ifscCode,
    },
    requestedBy: (req as any).adminId,
    requestedByType: "Admin",
  });

  await audit(
    req,
    "CREATE",
    payout,
    `Created ₹${amt} payout request for ${driver.fullName || driverId} (${payout.method})`,
  );

  res.locals.data = { payout };
};

/**
 * GET /admin/finance/payouts — list with optional status/driver filter + totals.
 */
export const listPayouts = async (req: Request, res: Response) => {
  const { status, driverId, page = 1, limit = 50 } = req.query;
  const filter: any = {};
  if (status) filter.status = status;
  if (driverId) filter.driverId = driverId;

  const skip = (Number(page) - 1) * Number(limit);
  const [payouts, total] = await Promise.all([
    Payout.find(filter)
      .populate("driverId", "fullName mobileNumber")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Payout.countDocuments(filter),
  ]);

  // Pending amount awaiting settlement.
  const pendingAgg = await Payout.aggregate([
    { $match: { status: { $in: ["PENDING", "APPROVED"] } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  res.locals.data = {
    payouts,
    pendingAmount: pendingAgg[0]?.total || 0,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

/**
 * PUT /admin/finance/payouts/:id/approve — PENDING → APPROVED.
 */
export const approvePayout = async (req: Request, res: Response) => {
  const { id } = req.params;
  const payout = await Payout.findById(id);
  if (!payout) {
    return res.status(404).json({ success: false, message: "Payout not found" });
  }
  if (payout.status !== "PENDING") {
    return res.status(400).json({
      success: false,
      message: `Only PENDING payouts can be approved (this is ${payout.status})`,
    });
  }

  payout.status = "APPROVED";
  payout.approvedBy = (req as any).adminId;
  payout.approvedAt = new Date();
  await payout.save();

  await audit(req, "APPROVE", payout, `Approved ₹${payout.amount} payout`);
  res.locals.data = { payout };
};

/**
 * PUT /admin/finance/payouts/:id/pay — APPROVED (or PENDING) → PAID.
 * Records the external reference (UTR/txn id). No gateway call — manual.
 */
export const markPayoutPaid = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reference } = req.body;
  const payout = await Payout.findById(id);
  if (!payout) {
    return res.status(404).json({ success: false, message: "Payout not found" });
  }
  if (payout.status === "PAID" || payout.status === "REJECTED") {
    return res.status(400).json({
      success: false,
      message: `Payout is already ${payout.status}`,
    });
  }

  payout.status = "PAID";
  payout.reference = reference || payout.reference;
  payout.paidBy = (req as any).adminId;
  payout.paidAt = new Date();
  await payout.save();

  // REFUND is the closest money-out audit action (impact CRITICAL).
  await audit(
    req,
    "REFUND",
    payout,
    `Marked ₹${payout.amount} payout PAID${payout.reference ? ` (ref ${payout.reference})` : ""}`,
  );
  res.locals.data = { payout };
};

/**
 * PUT /admin/finance/payouts/:id/reject — → REJECTED (not paid).
 */
export const rejectPayout = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;
  const payout = await Payout.findById(id);
  if (!payout) {
    return res.status(404).json({ success: false, message: "Payout not found" });
  }
  if (payout.status === "PAID") {
    return res.status(400).json({
      success: false,
      message: "A PAID payout cannot be rejected",
    });
  }

  payout.status = "REJECTED";
  payout.rejectedBy = (req as any).adminId;
  payout.rejectedAt = new Date();
  payout.rejectionReason = reason?.trim() || "Rejected by admin";
  await payout.save();

  await audit(
    req,
    "REJECT",
    payout,
    `Rejected ₹${payout.amount} payout — ${payout.rejectionReason}`,
  );
  res.locals.data = { payout };
};
