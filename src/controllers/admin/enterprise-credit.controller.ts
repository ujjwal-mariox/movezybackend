import { Request, Response } from "express";
import mongoose from "mongoose";
import { Enterprise } from "../../models/enterprise.model";
import { CreditHistory } from "../../models/credit-history.model";

/**
 * GET /admin/enterprises/:id/credit-history
 * Get credit history for an enterprise
 */
export const getCreditHistory = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { page = 0, limit = 20, type } = req.query;

  const query: any = { enterpriseId: id };
  if (type) query.type = type;

  const history = await CreditHistory.find(query)
    .populate("performedBy", "fullName email")
    .populate("bookingId", "bookingNumber")
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await CreditHistory.countDocuments(query);

  // Get summary
  const summary = await CreditHistory.aggregate([
    { $match: { enterpriseId: new mongoose.Types.ObjectId(id) } },
    {
      $group: {
        _id: "$type",
        totalAmount: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);

  res.locals.data = {
    history,
    summary,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

/**
 * POST /admin/enterprises/:id/credit/adjust
 * Adjust enterprise credit (increase or decrease used credit)
 */
export const adjustCredit = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, type, reason, bookingId } = req.body;

  const enterprise = await Enterprise.findById(id);
  if (!enterprise) {
    return res.status(404).json({ success: false, message: "Enterprise not found" });
  }

  if (enterprise.status !== "APPROVED") {
    return res.status(400).json({ success: false, message: "Enterprise is not approved" });
  }

  const balanceBefore = enterprise.usedCredit;
  let balanceAfter = balanceBefore;

  switch (type) {
    case "CREDIT_USED":
      // Increase used credit (booking on credit)
      if (balanceBefore + amount > enterprise.creditLimit) {
        return res.status(400).json({
          success: false,
          message: `Credit limit exceeded. Available: ${enterprise.creditLimit - balanceBefore}`,
        });
      }
      balanceAfter = balanceBefore + amount;
      break;

    case "CREDIT_REPAID":
      // Decrease used credit (payment received)
      balanceAfter = Math.max(0, balanceBefore - amount);
      break;

    case "ADJUSTMENT":
      // Direct adjustment (can be positive or negative)
      balanceAfter = Math.max(0, balanceBefore + amount);
      if (balanceAfter > enterprise.creditLimit) {
        return res.status(400).json({
          success: false,
          message: "Adjustment would exceed credit limit",
        });
      }
      break;

    default:
      return res.status(400).json({
        success: false,
        message: "Invalid adjustment type. Use: CREDIT_USED, CREDIT_REPAID, or ADJUSTMENT",
      });
  }

  // Create history record
  await CreditHistory.create({
    enterpriseId: id,
    type,
    amount,
    balanceBefore,
    balanceAfter,
    bookingId,
    reason,
    performedBy: req.adminId,
  });

  // Update enterprise
  enterprise.usedCredit = balanceAfter;
  await enterprise.save();

  res.locals.data = {
    message: "Credit adjusted successfully",
    balanceBefore,
    balanceAfter,
    availableCredit: enterprise.creditLimit - balanceAfter,
  };
};

/**
 * PUT /admin/enterprises/:id/credit-limit
 * Update enterprise credit limit
 */
export const updateCreditLimit = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { newLimit, reason } = req.body;

  const enterprise = await Enterprise.findById(id);
  if (!enterprise) {
    return res.status(404).json({ success: false, message: "Enterprise not found" });
  }

  if (newLimit < 0) {
    return res.status(400).json({ success: false, message: "Credit limit cannot be negative" });
  }

  if (newLimit < enterprise.usedCredit) {
    return res.status(400).json({
      success: false,
      message: `Cannot set limit below used credit (${enterprise.usedCredit})`,
    });
  }

  const limitBefore = enterprise.creditLimit;
  const type = newLimit > limitBefore ? "LIMIT_INCREASED" : "LIMIT_DECREASED";

  // Create history record
  await CreditHistory.create({
    enterpriseId: id,
    type,
    amount: Math.abs(newLimit - limitBefore),
    balanceBefore: enterprise.usedCredit,
    balanceAfter: enterprise.usedCredit,
    limitBefore,
    limitAfter: newLimit,
    reason,
    performedBy: req.adminId,
  });

  // Update enterprise
  enterprise.creditLimit = newLimit;
  await enterprise.save();

  res.locals.data = {
    message: "Credit limit updated successfully",
    limitBefore,
    limitAfter: newLimit,
    availableCredit: newLimit - enterprise.usedCredit,
  };
};

/**
 * GET /admin/enterprises/credit-summary
 * Get credit summary for all enterprises
 */
export const getCreditSummary = async (req: Request, res: Response) => {
  const summary = await Enterprise.aggregate([
    { $match: { status: "APPROVED", isActive: true } },
    {
      $group: {
        _id: null,
        totalCreditLimit: { $sum: "$creditLimit" },
        totalUsedCredit: { $sum: "$usedCredit" },
        enterpriseCount: { $sum: 1 },
        highUtilization: {
          $sum: {
            $cond: [
              { $gte: [{ $divide: ["$usedCredit", { $max: ["$creditLimit", 1] }] }, 0.8] },
              1,
              0,
            ],
          },
        },
        overLimit: {
          $sum: {
            $cond: [{ $gt: ["$usedCredit", "$creditLimit"] }, 1, 0],
          },
        },
      },
    },
    {
      $project: {
        totalCreditLimit: 1,
        totalUsedCredit: 1,
        totalAvailableCredit: { $subtract: ["$totalCreditLimit", "$totalUsedCredit"] },
        enterpriseCount: 1,
        highUtilizationCount: "$highUtilization",
        overLimitCount: "$overLimit",
        utilizationRate: {
          $multiply: [
            { $divide: ["$totalUsedCredit", { $max: ["$totalCreditLimit", 1] }] },
            100,
          ],
        },
      },
    },
  ]);

  // Get top credit users
  const topCreditUsers = await Enterprise.find({
    status: "APPROVED",
    isActive: true,
    usedCredit: { $gt: 0 },
  })
    .select("companyName creditLimit usedCredit")
    .sort({ usedCredit: -1 })
    .limit(10)
    .lean();

  // Add utilization percentage
  const topUsersWithUtilization = topCreditUsers.map((e) => ({
    ...e,
    availableCredit: e.creditLimit - e.usedCredit,
    utilizationPercent: ((e.usedCredit / Math.max(e.creditLimit, 1)) * 100).toFixed(1),
  }));

  res.locals.data = {
    summary: summary[0] || {
      totalCreditLimit: 0,
      totalUsedCredit: 0,
      totalAvailableCredit: 0,
      enterpriseCount: 0,
      highUtilizationCount: 0,
      overLimitCount: 0,
      utilizationRate: 0,
    },
    topCreditUsers: topUsersWithUtilization,
  };
};

/**
 * GET /admin/enterprises/overdue
 * Get enterprises with overdue payments
 */
export const getOverdueEnterprises = async (req: Request, res: Response) => {
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = { error: "Database not connected" };
    return;
  }

  try {
    const invoicesCollection = db.collection("invoices");

    const overdueEnterprises = await invoicesCollection
      .aggregate([
        {
          $match: {
            enterpriseId: { $exists: true },
            status: { $in: ["GENERATED", "SENT", "OVERDUE"] },
            dueDate: { $lt: new Date() },
          },
        },
        {
          $group: {
            _id: "$enterpriseId",
            overdueAmount: { $sum: "$amount" },
            invoiceCount: { $sum: 1 },
            oldestDueDate: { $min: "$dueDate" },
          },
        },
        {
          $lookup: {
            from: "enterprises",
            localField: "_id",
            foreignField: "_id",
            as: "enterprise",
          },
        },
        { $unwind: "$enterprise" },
        {
          $project: {
            enterpriseId: "$_id",
            companyName: "$enterprise.companyName",
            contactPerson: "$enterprise.contactPerson",
            email: "$enterprise.email",
            phone: "$enterprise.phone",
            overdueAmount: 1,
            invoiceCount: 1,
            oldestDueDate: 1,
            daysOverdue: {
              $divide: [
                { $subtract: [new Date(), "$oldestDueDate"] },
                1000 * 60 * 60 * 24,
              ],
            },
            creditLimit: "$enterprise.creditLimit",
            usedCredit: "$enterprise.usedCredit",
          },
        },
        { $sort: { overdueAmount: -1 } },
      ])
      .toArray();

    res.locals.data = {
      overdueEnterprises,
      totalOverdue: overdueEnterprises.reduce((sum, e) => sum + e.overdueAmount, 0),
      count: overdueEnterprises.length,
    };
  } catch (err) {
    console.error("[Enterprise] Overdue error:", err);
    res.locals.data = { error: "Failed to fetch overdue enterprises" };
  }
};
