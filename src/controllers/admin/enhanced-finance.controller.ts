import { Request, Response } from "express";
import mongoose from "mongoose";
import { Expense } from "../../models/expense.model";
import { Enterprise } from "../../models/enterprise.model";
import Booking from "../../models/booking.model";

/**
 * GET /admin/finance/enhanced-overview
 * Enhanced finance overview with all metrics
 */
export const getEnhancedOverview = async (req: Request, res: Response) => {
  const { dateFrom, dateTo, period } = req.query;
  const db = mongoose.connection.db;

  if (!db) {
    res.locals.data = { error: "Database not connected" };
    return;
  }

  // Parse date range
  let startDate: Date;
  let endDate: Date = new Date();

  if (dateFrom && dateTo) {
    startDate = new Date(dateFrom as string);
    endDate = new Date(dateTo as string);
    endDate.setHours(23, 59, 59, 999);
  } else {
    // Default period handling
    const now = new Date();
    switch (period) {
      case "week":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "year":
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      case "quarter":
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      default: // month
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
  }

  try {
    const bookingsCollection = db.collection("bookings");
    const expensesCollection = db.collection("expenses");
    const invoicesCollection = db.collection("invoices");

    const [
      revenueData,
      expenseData,
      paymentMethods,
      dailyRevenue,
      codData,
      enterpriseCredit,
      invoiceAging,
    ] = await Promise.all([
      // Revenue metrics
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate },
              status: { $in: ["COMPLETED", "completed", "delivered"] },
            },
          },
          {
            $group: {
              _id: null,
              grossRevenue: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
              totalOrders: { $sum: 1 },
              avgOrderValue: { $avg: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
              // No per-booking commission field exists; approximate as 20% of
              // fare (matches finance.controller). The old $commission /
              // $fare.commission paths don't exist → always summed to 0.
              totalCommission: {
                $sum: {
                  $multiply: [{ $ifNull: ["$finalFare", 0] }, 0.2],
                },
              },
              totalRefunds: { $sum: "$refundAmount" },
              refundCount: {
                $sum: { $cond: [{ $eq: ["$refundStatus", "PROCESSED"] }, 1, 0] },
              },
            },
          },
        ])
        .toArray(),

      // Expense metrics
      expensesCollection
        .aggregate([
          {
            $match: {
              date: { $gte: startDate, $lte: endDate },
              status: { $in: ["APPROVED", "PAID"] },
            },
          },
          {
            $group: {
              _id: "$category",
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),

      // Payment method breakdown
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate },
              status: { $in: ["COMPLETED", "completed", "delivered"] },
            },
          },
          {
            $group: {
              _id: "$paymentMethod",
              count: { $sum: 1 },
              total: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
            },
          },
          { $sort: { total: -1 } },
        ])
        .toArray(),

      // Daily revenue trend
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate },
              status: { $in: ["COMPLETED", "completed", "delivered"] },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              revenue: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
              orders: { $sum: 1 },
              // Same 20% approximation as the summary — no commission field exists.
              commission: {
                $sum: { $multiply: [{ $ifNull: ["$finalFare", 0] }, 0.2] },
              },
              expenses: { $sum: 0 }, // Will be merged with expense data
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),

      // COD metrics
      bookingsCollection
        .aggregate([
          {
            $match: {
              paymentMethod: "CASH",
              status: { $in: ["COMPLETED", "completed", "delivered"] },
            },
          },
          {
            $facet: {
              total: [
                { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
                {
                  $group: {
                    _id: null,
                    collected: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
                    orders: { $sum: 1 },
                  },
                },
              ],
              unsettled: [
                {
                  $match: {
                    $or: [
                      { "codSettlement.status": { $ne: "settled" } },
                      { codSettlement: { $exists: false } },
                    ],
                  },
                },
                {
                  $group: {
                    _id: null,
                    pending: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
                    pendingOrders: { $sum: 1 },
                  },
                },
              ],
            },
          },
        ])
        .toArray(),

      // Enterprise credit outstanding
      Enterprise.aggregate([
        { $match: { status: "APPROVED", isActive: true } },
        {
          $group: {
            _id: null,
            totalCreditLimit: { $sum: "$creditLimit" },
            totalUsedCredit: { $sum: "$usedCredit" },
            enterpriseCount: { $sum: 1 },
          },
        },
      ]),

      // Invoice aging for DSO calculation
      invoicesCollection
        .aggregate([
          {
            $match: {
              status: { $in: ["GENERATED", "SENT"] },
              createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
            },
          },
          {
            $project: {
              amount: 1,
              daysOutstanding: {
                $divide: [
                  { $subtract: [new Date(), "$createdAt"] },
                  1000 * 60 * 60 * 24,
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              totalOutstanding: { $sum: "$amount" },
              avgDaysOutstanding: { $avg: "$daysOutstanding" },
              invoiceCount: { $sum: 1 },
              aging0to30: {
                $sum: { $cond: [{ $lte: ["$daysOutstanding", 30] }, "$amount", 0] },
              },
              aging31to60: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ["$daysOutstanding", 30] }, { $lte: ["$daysOutstanding", 60] }] },
                    "$amount",
                    0,
                  ],
                },
              },
              aging61to90: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ["$daysOutstanding", 60] }, { $lte: ["$daysOutstanding", 90] }] },
                    "$amount",
                    0,
                  ],
                },
              },
              aging90plus: {
                $sum: { $cond: [{ $gt: ["$daysOutstanding", 90] }, "$amount", 0] },
              },
            },
          },
        ])
        .toArray(),
    ]);

    // Calculate metrics
    const revenue = revenueData[0] || {};
    const gross = revenue.grossRevenue || 0;
    const refunds = revenue.totalRefunds || 0;
    const totalExpenses = expenseData.reduce((sum: number, e: any) => sum + e.total, 0);

    // Calculate DSO (Days Sales Outstanding)
    const avgDailyRevenue = gross / Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const dso = invoiceAging[0]?.totalOutstanding && avgDailyRevenue > 0
      ? (invoiceAging[0].totalOutstanding / avgDailyRevenue).toFixed(1)
      : 0;

    res.locals.data = {
      summary: {
        grossRevenue: gross,
        netRevenue: gross - refunds - totalExpenses,
        totalCommission: revenue.totalCommission || 0,
        totalRefunds: refunds,
        refundCount: revenue.refundCount || 0,
        refundRatio: revenue.totalOrders > 0 
          ? ((revenue.refundCount || 0) / revenue.totalOrders * 100).toFixed(2)
          : 0,
        totalOrders: revenue.totalOrders || 0,
        avgOrderValue: revenue.avgOrderValue?.toFixed(2) || 0,
        totalExpenses,
        netProfit: gross - refunds - totalExpenses,
        profitMargin: gross > 0 ? (((gross - refunds - totalExpenses) / gross) * 100).toFixed(2) : 0,
      },
      expenses: {
        byCategory: expenseData,
        total: totalExpenses,
      },
      paymentMethods,
      dailyRevenue,
      cod: {
        collected: codData[0]?.total?.[0]?.collected || 0,
        orders: codData[0]?.total?.[0]?.orders || 0,
        pendingSettlement: codData[0]?.unsettled?.[0]?.pending || 0,
        pendingOrders: codData[0]?.unsettled?.[0]?.pendingOrders || 0,
      },
      enterpriseCredit: {
        totalLimit: enterpriseCredit[0]?.totalCreditLimit || 0,
        totalUsed: enterpriseCredit[0]?.totalUsedCredit || 0,
        available: (enterpriseCredit[0]?.totalCreditLimit || 0) - (enterpriseCredit[0]?.totalUsedCredit || 0),
        enterpriseCount: enterpriseCredit[0]?.enterpriseCount || 0,
      },
      dso: {
        days: dso,
        totalOutstanding: invoiceAging[0]?.totalOutstanding || 0,
        invoiceCount: invoiceAging[0]?.invoiceCount || 0,
        aging: {
          "0-30": invoiceAging[0]?.aging0to30 || 0,
          "31-60": invoiceAging[0]?.aging31to60 || 0,
          "61-90": invoiceAging[0]?.aging61to90 || 0,
          "90+": invoiceAging[0]?.aging90plus || 0,
        },
      },
      dateRange: { from: startDate, to: endDate },
    };
  } catch (err) {
    console.error("[Finance] Enhanced overview error:", err);
    res.locals.data = { error: "Failed to fetch finance data" };
  }
};

/**
 * GET /admin/finance/expenses
 * Get all expenses with filters
 */
export const getExpenses = async (req: Request, res: Response) => {
  const { category, status, dateFrom, dateTo, page = 0, limit = 20 } = req.query;

  const query: any = {};

  if (category) query.category = category;
  if (status) query.status = status;

  if (dateFrom || dateTo) {
    query.date = {};
    if (dateFrom) query.date.$gte = new Date(dateFrom as string);
    if (dateTo) query.date.$lte = new Date(dateTo as string);
  }

  const expenses = await Expense.find(query)
    .populate("createdBy", "fullName email")
    .populate("approvedBy", "fullName email")
    .populate("driverId", "fullName mobileNumber")
    .sort({ date: -1, createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await Expense.countDocuments(query);

  // Category totals
  const categoryTotals = await Expense.aggregate([
    { $match: query },
    {
      $group: {
        _id: "$category",
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);

  res.locals.data = {
    expenses,
    categoryTotals,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

/**
 * POST /admin/finance/expenses
 * Create a new expense
 */
export const createExpense = async (req: Request, res: Response) => {
  const { category, subcategory, amount, description, date, driverId, notes, paymentMethod } = req.body;

  const expense = await Expense.create({
    category,
    subcategory,
    amount,
    description,
    date: new Date(date),
    driverId,
    notes,
    paymentMethod,
    status: "PENDING",
    createdBy: req.adminId,
  });

  res.locals.data = { message: "Expense created", expense };
};

/**
 * PUT /admin/finance/expenses/:id/approve
 * Approve an expense
 */
export const approveExpense = async (req: Request, res: Response) => {
  const { id } = req.params;

  const expense = await Expense.findById(id);

  if (!expense) {
    return res.status(404).json({ success: false, message: "Expense not found" });
  }

  if (expense.status !== "PENDING") {
    return res.status(400).json({ success: false, message: "Expense is not pending" });
  }

  expense.status = "APPROVED";
  expense.approvedBy = new mongoose.Types.ObjectId(req.adminId);
  expense.approvedAt = new Date();

  await expense.save();

  res.locals.data = { message: "Expense approved", expense };
};

/**
 * PUT /admin/finance/expenses/:id/pay
 * Mark expense as paid
 */
export const markExpensePaid = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { transactionId, paymentMethod } = req.body;

  const expense = await Expense.findById(id);

  if (!expense) {
    return res.status(404).json({ success: false, message: "Expense not found" });
  }

  if (expense.status !== "APPROVED") {
    return res.status(400).json({ success: false, message: "Expense must be approved first" });
  }

  expense.status = "PAID";
  expense.transactionId = transactionId;
  if (paymentMethod) expense.paymentMethod = paymentMethod;

  await expense.save();

  res.locals.data = { message: "Expense marked as paid", expense };
};

/**
 * GET /admin/finance/dso
 * Get detailed DSO (Days Sales Outstanding) metrics
 */
export const getDSOMetrics = async (req: Request, res: Response) => {
  const db = mongoose.connection.db;

  if (!db) {
    res.locals.data = { error: "Database not connected" };
    return;
  }

  try {
    const invoicesCollection = db.collection("invoices");
    const bookingsCollection = db.collection("bookings");

    // Last 90 days of revenue for DSO calculation
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [invoiceMetrics, revenueMetrics, enterpriseAR] = await Promise.all([
      // Outstanding invoices
      invoicesCollection
        .aggregate([
          {
            $match: {
              status: { $in: ["GENERATED", "SENT", "OVERDUE"] },
            },
          },
          {
            $project: {
              amount: 1,
              enterpriseId: 1,
              daysOutstanding: {
                $divide: [
                  { $subtract: [new Date(), "$createdAt"] },
                  1000 * 60 * 60 * 24,
                ],
              },
              isOverdue: {
                $cond: [
                  { $gt: [new Date(), "$dueDate"] },
                  true,
                  false,
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              totalAR: { $sum: "$amount" },
              avgDaysOutstanding: { $avg: "$daysOutstanding" },
              overdueAmount: {
                $sum: { $cond: ["$isOverdue", "$amount", 0] },
              },
              overdueCount: {
                $sum: { $cond: ["$isOverdue", 1, 0] },
              },
              totalCount: { $sum: 1 },
            },
          },
        ])
        .toArray(),

      // Revenue for DSO calculation
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: ninetyDaysAgo },
              status: { $in: ["COMPLETED", "completed", "delivered"] },
            },
          },
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
            },
          },
        ])
        .toArray(),

      // AR by enterprise
      invoicesCollection
        .aggregate([
          {
            $match: {
              status: { $in: ["GENERATED", "SENT", "OVERDUE"] },
              enterpriseId: { $exists: true },
            },
          },
          {
            $group: {
              _id: "$enterpriseId",
              outstanding: { $sum: "$amount" },
              count: { $sum: 1 },
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
              enterpriseName: "$enterprise.companyName",
              outstanding: 1,
              count: 1,
            },
          },
          { $sort: { outstanding: -1 } },
          { $limit: 10 },
        ])
        .toArray(),
    ]);

    const totalRevenue90Days = revenueMetrics[0]?.totalRevenue || 1;
    const avgDailyRevenue = totalRevenue90Days / 90;
    const totalAR = invoiceMetrics[0]?.totalAR || 0;
    const dso = avgDailyRevenue > 0 ? (totalAR / avgDailyRevenue).toFixed(1) : 0;

    res.locals.data = {
      dso: Number(dso),
      totalAccountsReceivable: totalAR,
      avgDaysOutstanding: invoiceMetrics[0]?.avgDaysOutstanding?.toFixed(1) || 0,
      overdueAmount: invoiceMetrics[0]?.overdueAmount || 0,
      overdueInvoices: invoiceMetrics[0]?.overdueCount || 0,
      totalInvoices: invoiceMetrics[0]?.totalCount || 0,
      avgDailyRevenue: avgDailyRevenue.toFixed(2),
      topEnterpriseAR: enterpriseAR,
    };
  } catch (err) {
    console.error("[Finance] DSO metrics error:", err);
    res.locals.data = { error: "Failed to fetch DSO metrics" };
  }
};

/**
 * GET /admin/finance/export
 * Export finance data
 */
export const exportFinanceData = async (req: Request, res: Response) => {
  const { dateFrom, dateTo, type = "revenue" } = req.query;

  const startDate = dateFrom ? new Date(dateFrom as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = dateTo ? new Date(dateTo as string) : new Date();

  let data: any[] = [];

  if (type === "expenses") {
    data = await Expense.find({
      date: { $gte: startDate, $lte: endDate },
    })
      .populate("createdBy", "fullName")
      .populate("driverId", "fullName")
      .lean();
  } else {
    data = await Booking.find({
      createdAt: { $gte: startDate, $lte: endDate },
      status: "COMPLETED",
    })
      .populate("userId", "fullName mobileNumber")
      .populate("driverId", "fullName mobileNumber")
      .select("bookingNumber finalFare paymentMethod paymentStatus createdAt completedAt")
      .lean();
  }

  res.locals.data = {
    data,
    count: data.length,
    dateRange: { from: startDate, to: endDate },
    type,
  };
};
