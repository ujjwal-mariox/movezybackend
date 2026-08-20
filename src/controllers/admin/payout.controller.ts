import { Request, Response } from "express";
import Payout from "../../models/payout.model";
import Driver from "../../models/driver.model";
import { Expense } from "../../models/expense.model";
import { AppConfig } from "../../models/app-config.model";
import { createAuditEntry } from "./audit-log.controller";
import * as DriverPayoutService from "../../services/driver-payout.service";

/**
 * Four-eyes on money out: whether the requester/approver/payer must be
 * different admins. OFF by default — the client currently operates with a
 * single admin account, and with the rule always-on an admin-created payout
 * could never be approved and an approved one could never be paid, so no
 * payout could ever complete. Flip `payout_four_eyes_enabled` to true in
 * System Configuration once there are enough admins to share the duty.
 * Every step is audit-logged with the acting admin either way.
 */
const isFourEyesEnabled = async (): Promise<boolean> => {
  const doc: any = await AppConfig.findOne({
    key: "payout_four_eyes_enabled",
  }).lean();
  return doc?.value === true || doc?.value === "true";
};

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

  // The driver's own withdrawal route enforces all of this
  // (driver.controller withdrawFromWallet); this admin path enforced only
  // "amount > 0", so it could pay money the driver had already withdrawn.
  // available = earnings + awarded incentives - payouts already PENDING/
  // APPROVED/PAID, so an existing request is subtracted here too and a second
  // click cannot double-pay.
  const balance = await DriverPayoutService.getDriverAvailableBalance(driverId);
  if (amt > balance.available) {
    return res.status(400).json({
      success: false,
      message:
        `Only ₹${balance.available.toFixed(2)} is available for payout. ` +
        `Lifetime earnings ₹${balance.lifetimeEarnings.toFixed(2)}, ` +
        `₹${balance.reserved.toFixed(2)} already requested or paid.`,
      data: balance,
    });
  }

  // A bank transfer with no account on file creates a payout that can never be
  // executed — and bankSnapshot silently recorded empty strings.
  const needsBank = (method || "BANK") !== "CASH";
  if (needsBank && !(bank.accountNumber && bank.ifscCode)) {
    return res.status(400).json({
      success: false,
      message:
        "This driver has no bank account on file, so a bank/UPI payout cannot be created.",
    });
  }
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
    // The UI hides Approve / Mark-paid on rows the acting admin isn't allowed
    // to action — but only when the rule is actually on.
    fourEyes: await isFourEyesEnabled(),
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

  // Four eyes on money out — only when enabled (see isFourEyesEnabled).
  if (
    payout.requestedByType === "Admin" &&
    String(payout.requestedBy) === String((req as any).adminId) &&
    (await isFourEyesEnabled())
  ) {
    return res.status(400).json({
      success: false,
      message:
        "You cannot approve a payout you requested yourself. Another admin must approve it.",
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

  // Money only leaves against an approval. Paying a PENDING payout was allowed,
  // which meant one admin could create a payout and immediately mark it PAID —
  // the whole money-out lifecycle with a single actor and no approval on record.
  if (payout.status !== "APPROVED") {
    return res.status(400).json({
      success: false,
      message: `A payout must be APPROVED before it can be marked paid (this is ${payout.status})`,
    });
  }

  // ...and the approver cannot also be the payer — only when four-eyes is on.
  if (
    String(payout.approvedBy) === String((req as any).adminId) &&
    (await isFourEyesEnabled())
  ) {
    return res.status(400).json({
      success: false,
      message:
        "You approved this payout, so a different admin must mark it paid.",
    });
  }

  payout.status = "PAID";
  payout.reference = reference || payout.reference;
  payout.paidBy = (req as any).adminId;
  payout.paidAt = new Date();
  await payout.save();

  // Book the payout as an expense, the way a processed refund does. Driver
  // payables are the platform's largest cost and nothing ever wrote them to
  // `expenses`, so Net Profit was computed as if drivers were paid nothing.
  // The DRIVER_PAYOUT category already existed and had never been written.
  // Guarded so a bookkeeping failure cannot undo money that has already left.
  try {
    await Expense.create({
      category: "DRIVER_PAYOUT",
      amount: payout.amount,
      description: `Driver payout${payout.reference ? ` (ref ${payout.reference})` : ""}`,
      date: payout.paidAt,
      driverId: payout.driverId,
      transactionId: payout.reference,
      status: "PAID",
      createdBy: (req as any).adminId,
    });
  } catch (err) {
    console.error("Payout marked PAID but expense row failed:", err);
  }

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
