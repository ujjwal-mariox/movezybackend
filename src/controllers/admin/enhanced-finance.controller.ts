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
      refundData,
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
              // Real commission, frozen on each booking at completion. This
              // used to multiply gross by a hardcoded 0.2, so the dashboard
              // reported a commission the platform was not actually taking.
              totalCommission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
              // GST collected from customers. It is inside grossRevenue but is
              // not platform income — it is remitted. Reported separately so
              // the finance page can show it instead of implying the platform
              // keeps it.
              totalGST: { $sum: { $ifNull: ["$gstAmount", 0] } },
            },
          },
        ])
        .toArray(),

      // Refunds — deliberately OUTSIDE the status-filtered pipeline above.
      // Summing refundAmount inside a $match restricted to COMPLETED bookings
      // missed every refund on a CANCELLED trip (the normal case), so this card
      // disagreed with /admin/finance/overview for the same period and did not
      // move at all when a cancelled booking was refunded. Same filter as
      // finance.controller.ts getFinanceOverview so the two agree.
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate },
              refundAmount: { $gt: 0 },
            },
          },
          {
            $group: {
              _id: null,
              totalRefunds: { $sum: "$refundAmount" },
              refundCount: { $sum: 1 },
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
              // Real per-booking commission, as in the summary above.
              commission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
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
            // "SENT"/"OVERDUE" are not in the Invoice status enum
            // (invoice.model.ts: GENERATED | PAID | CANCELLED | REFUNDED), so
            // only GENERATED can ever match. GENERATED = raised, not yet paid.
            $match: {
              status: { $in: ["GENERATED"] },
              createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
            },
          },
          {
            $project: {
              // The invoice total is `grandTotal`; there is no `amount` path on
              // the schema, so every $sum over it returned 0 and the whole
              // aging table read ₹0 next to a real invoice count.
              amount: { $ifNull: ["$grandTotal", 0] },
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
    const refunds = refundData[0]?.totalRefunds || 0;
    const refundCount = refundData[0]?.refundCount || 0;

    // Refunds are already subtracted as booking.refundAmount above, and the
    // refund approval flow ALSO auto-creates an Expense{category:"REFUND"}
    // (refund.controller.ts). Counting that expense here subtracted the same
    // refund twice and put it in the admin's "Total Expenses" tile for an item
    // they never entered. Operating expenses only, therefore.
    const refundExpenses = expenseData
      .filter((e: any) => e._id === "REFUND")
      .reduce((sum: number, e: any) => sum + e.total, 0);
    const totalExpenses = expenseData
      .filter((e: any) => e._id !== "REFUND")
      .reduce((sum: number, e: any) => sum + e.total, 0);

    // Calculate DSO (Days Sales Outstanding). With no revenue in the range there
    // is no daily-revenue denominator, so DSO is unknown — report null rather
    // than "0 days", which reads as "nothing outstanding".
    const avgDailyRevenue = gross / Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const outstanding = invoiceAging[0]?.totalOutstanding || 0;
    const dso =
      avgDailyRevenue > 0
        ? Number((outstanding / avgDailyRevenue).toFixed(1))
        : outstanding === 0
          ? 0
          : null;

    res.locals.data = {
      summary: {
        grossRevenue: gross,
        // Revenue net of refunds — the same basis /admin/finance/overview uses.
        // Operating expenses belong to netProfit below, not to net revenue.
        netRevenue: gross - refunds,
        totalCommission: revenue.totalCommission || 0,
        // Customer GST collected in the window — remitted, not platform income.
        totalGST: revenue.totalGST || 0,
        totalRefunds: refunds,
        refundCount,
        refundRatio: revenue.totalOrders > 0
          ? Number((((refundCount / revenue.totalOrders) * 100)).toFixed(2))
          : 0,
        totalOrders: revenue.totalOrders || 0,
        avgOrderValue: Number((revenue.avgOrderValue || 0).toFixed(2)),
        // Operating expenses (REFUND-category rows excluded — see above).
        // Includes DRIVER_PAYOUT rows, which markPayoutPaid now writes; they
        // are dated when the payout was settled, so a payout can land in a
        // different window from the trips that earned it.
        totalExpenses,
        refundExpenses,
        netProfit: gross - refunds - totalExpenses,
        profitMargin: gross > 0 ? Number(((((gross - refunds - totalExpenses) / gross) * 100)).toFixed(2)) : 0,
      },
      expenses: {
        // Full category list, REFUND included, so the Expenses tab can still
        // show refund payouts as their own line.
        byCategory: expenseData,
        total: totalExpenses,
        refundExpenses,
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
        totalOutstanding: outstanding,
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
            // Only GENERATED exists in the Invoice status enum for an unpaid
            // invoice; "SENT"/"OVERDUE" were never storable values.
            $match: {
              status: { $in: ["GENERATED"] },
            },
          },
          {
            $project: {
              // `grandTotal` is the invoice total. Summing the non-existent
              // `amount` path returned 0, which is why Total Outstanding and
              // Overdue Amount both read ₹0 beside a real invoice count.
              amount: { $ifNull: ["$grandTotal", 0] },
              enterpriseId: 1,
              daysOutstanding: {
                $divide: [
                  { $subtract: [new Date(), "$createdAt"] },
                  1000 * 60 * 60 * 24,
                ],
              },
              // Overdue needs a real due date. `dueDate` is only set where a
              // payment term actually exists (enterprise credit invoices, from
              // Enterprise.paymentTerms — see invoice.service.generateInvoice).
              // Invoices without one are NOT counted as overdue; the previous
              // `now > $dueDate` compared against a missing field, which is
              // true in BSON order, so every invoice counted as overdue.
              isOverdue: {
                $cond: [
                  {
                    $and: [
                      // $type is "missing" when the field is absent and "null"
                      // when it is null — only a real date can be overdue.
                      { $eq: [{ $type: "$dueDate" }, "date"] },
                      { $gt: [new Date(), "$dueDate"] },
                    ],
                  },
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
              status: { $in: ["GENERATED"] },
              enterpriseId: { $exists: true },
            },
          },
          {
            $group: {
              _id: "$enterpriseId",
              // `grandTotal`, not `amount` — see the pipeline above.
              outstanding: { $sum: { $ifNull: ["$grandTotal", 0] } },
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

    // No `|| 1` fallback: pretending ₹1 of 90-day revenue turned "no revenue"
    // into a DSO of totalAR × 90 days. With no revenue in the window DSO is
    // simply not computable, so report null rather than a made-up number.
    const totalRevenue90Days = revenueMetrics[0]?.totalRevenue || 0;
    const avgDailyRevenue = totalRevenue90Days / 90;
    const totalAR = invoiceMetrics[0]?.totalAR || 0;
    const dso =
      avgDailyRevenue > 0
        ? Number((totalAR / avgDailyRevenue).toFixed(1))
        : null;

    res.locals.data = {
      dso,
      totalAccountsReceivable: totalAR,
      avgDaysOutstanding: Number((invoiceMetrics[0]?.avgDaysOutstanding || 0).toFixed(1)),
      overdueAmount: invoiceMetrics[0]?.overdueAmount || 0,
      overdueInvoices: invoiceMetrics[0]?.overdueCount || 0,
      totalInvoices: invoiceMetrics[0]?.totalCount || 0,
      avgDailyRevenue: Number(avgDailyRevenue.toFixed(2)),
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
