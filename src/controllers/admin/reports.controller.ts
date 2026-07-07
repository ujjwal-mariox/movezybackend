import { Request, Response } from "express";
import Booking from "../../models/booking.model";
import User from "../../models/Users";
import Driver from "../../models/driver.model";
import { SupportTicket } from "../../models/support-ticket.model";

type RangeKey = "7D" | "30D" | "90D" | "YTD";

const resolveRange = (range: RangeKey = "30D") => {
  const now = new Date();
  let start: Date;
  let format: string;
  switch (range) {
    case "7D":
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      format = "%Y-%m-%d";
      break;
    case "30D":
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      format = "%Y-%m-%d";
      break;
    case "90D":
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      format = "%Y-%U";
      break;
    case "YTD":
      start = new Date(now.getFullYear(), 0, 1);
      format = "%Y-%m";
      break;
    default:
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      format = "%Y-%m-%d";
  }
  return { start, end: now, format };
};

/**
 * Get dashboard stats
 */
export const getDashboardStats = async (req: Request, res: Response) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

  // Parallel queries for efficiency
  const [
    totalBookings,
    todayBookings,
    monthBookings,
    lastMonthBookings,
    completedBookings,
    cancelledBookings,
    totalRevenue,
    monthRevenue,
    lastMonthRevenue,
    totalUsers,
    newUsersToday,
    newUsersMonth,
    totalDrivers,
    approvedDrivers,
    onlineDrivers,
    pendingVerifications,
    openTickets,
    bookingsByStatus,
  ] = await Promise.all([
    Booking.countDocuments(),
    Booking.countDocuments({ createdAt: { $gte: today } }),
    Booking.countDocuments({ createdAt: { $gte: thisMonth } }),
    Booking.countDocuments({
      createdAt: { $gte: lastMonth, $lt: thisMonth },
    }),
    Booking.countDocuments({ status: "COMPLETED" }),
    Booking.countDocuments({ status: "CANCELLED" }),
    Booking.aggregate([
      { $match: { status: "COMPLETED" } },
      { $group: { _id: null, total: { $sum: "$finalFare" } } },
    ]),
    Booking.aggregate([
      { $match: { status: "COMPLETED", createdAt: { $gte: thisMonth } } },
      { $group: { _id: null, total: { $sum: "$finalFare" } } },
    ]),
    Booking.aggregate([
      {
        $match: {
          status: "COMPLETED",
          createdAt: { $gte: lastMonth, $lt: thisMonth },
        },
      },
      { $group: { _id: null, total: { $sum: "$finalFare" } } },
    ]),
    User.countDocuments({ isDeleted: false }),
    User.countDocuments({ createdAt: { $gte: today } }),
    User.countDocuments({ createdAt: { $gte: thisMonth } }),
    Driver.countDocuments({ isDeleted: false }),
    Driver.countDocuments({ isDeleted: false, status: "approved" }),
    Driver.countDocuments({
      isDeleted: false,
      status: "approved",
      isOnline: true,
    }),
    Driver.countDocuments({
      isDeleted: false,
      status: { $in: ["documents_uploaded", "under_verification"] },
    }),
    SupportTicket.countDocuments({ status: { $in: ["OPEN", "IN_PROGRESS"] } }),
    Booking.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  // Calculate growth percentages
  const bookingGrowth =
    lastMonthBookings > 0
      ? (
          ((monthBookings - lastMonthBookings) / lastMonthBookings) *
          100
        ).toFixed(1)
      : 0;

  const currentMonthRevenue = monthRevenue[0]?.total || 0;
  const previousMonthRevenue = lastMonthRevenue[0]?.total || 0;
  const revenueGrowth =
    previousMonthRevenue > 0
      ? (
          ((currentMonthRevenue - previousMonthRevenue) /
            previousMonthRevenue) *
          100
        ).toFixed(1)
      : 0;

  res.locals.data = {
    bookings: {
      total: totalBookings,
      today: todayBookings,
      thisMonth: monthBookings,
      completed: completedBookings,
      cancelled: cancelledBookings,
      growth: `${Number(bookingGrowth) >= 0 ? "+" : ""}${bookingGrowth}%`,
      byStatus: bookingsByStatus,
    },
    revenue: {
      total: totalRevenue[0]?.total || 0,
      thisMonth: currentMonthRevenue,
      growth: `${Number(revenueGrowth) >= 0 ? "+" : ""}${revenueGrowth}%`,
    },
    users: {
      total: totalUsers,
      newToday: newUsersToday,
      newThisMonth: newUsersMonth,
    },
    drivers: {
      total: totalDrivers,
      approved: approvedDrivers,
      online: onlineDrivers,
      pendingVerification: pendingVerifications,
    },
    support: {
      openTickets,
    },
  };
};

/**
 * Get booking reports
 */
export const getBookingReports = async (req: Request, res: Response) => {
  const { dateFrom, dateTo, groupBy = "day" } = req.query;

  const startDate = dateFrom
    ? new Date(dateFrom as string)
    : new Date(new Date().setDate(new Date().getDate() - 30));
  const endDate = dateTo ? new Date(dateTo as string) : new Date();

  let dateFormat: string;
  switch (groupBy) {
    case "hour":
      dateFormat = "%Y-%m-%d %H:00";
      break;
    case "week":
      dateFormat = "%Y-W%V";
      break;
    case "month":
      dateFormat = "%Y-%m";
      break;
    default:
      dateFormat = "%Y-%m-%d";
  }

  const bookingTrend = await Booking.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: dateFormat, date: "$createdAt" } },
          status: "$status",
        },
        count: { $sum: 1 },
        revenue: { $sum: "$finalFare" },
      },
    },
    { $sort: { "_id.date": 1 } },
  ]);

  const vehicleTypeBreakdown = await Booking.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $lookup: {
        from: "vehicletypes",
        localField: "vehicleTypeId",
        foreignField: "_id",
        as: "vehicleType",
      },
    },
    {
      $group: {
        _id: { $arrayElemAt: ["$vehicleType.name", 0] },
        count: { $sum: 1 },
        revenue: { $sum: "$finalFare" },
      },
    },
  ]);

  res.locals.data = {
    dateRange: { from: startDate, to: endDate },
    bookingTrend,
    vehicleTypeBreakdown,
  };
};

/**
 * Get revenue reports
 */
export const getRevenueReports = async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;

  const startDate = dateFrom
    ? new Date(dateFrom as string)
    : new Date(new Date().setDate(new Date().getDate() - 30));
  const endDate = dateTo ? new Date(dateTo as string) : new Date();

  const revenueBreakdown = await Booking.aggregate([
    {
      $match: {
        status: "COMPLETED",
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        totalRevenue: { $sum: "$finalFare" },
        totalGST: { $sum: "$gstAmount" },
        totalDiscount: { $sum: "$totalDiscount" },
        bookingCount: { $sum: 1 },
        avgFare: { $avg: "$finalFare" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const paymentMethodBreakdown = await Booking.aggregate([
    {
      $match: {
        status: "COMPLETED",
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: "$paymentMethod",
        count: { $sum: 1 },
        total: { $sum: "$finalFare" },
      },
    },
  ]);

  res.locals.data = {
    dateRange: { from: startDate, to: endDate },
    daily: revenueBreakdown,
    byPaymentMethod: paymentMethodBreakdown,
  };
};

/**
 * Get user reports
 */
export const getUserReports = async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;

  const startDate = dateFrom
    ? new Date(dateFrom as string)
    : new Date(new Date().setFullYear(new Date().getFullYear() - 1));
  const endDate = dateTo ? new Date(dateTo as string) : new Date();

  const userGrowth = await User.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Top users by bookings
  const topUsers = await Booking.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: "$userId",
        bookingCount: { $sum: 1 },
        totalSpent: { $sum: "$finalFare" },
      },
    },
    { $sort: { totalSpent: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    {
      $project: {
        user: { $arrayElemAt: ["$user", 0] },
        bookingCount: 1,
        totalSpent: 1,
      },
    },
  ]);

  res.locals.data = {
    growth: userGrowth,
    topUsers,
  };
};

/**
 * Get driver reports
 */
export const getDriverReports = async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;

  const startDate = dateFrom
    ? new Date(dateFrom as string)
    : new Date(new Date().setDate(new Date().getDate() - 30));
  const endDate = dateTo ? new Date(dateTo as string) : new Date();

  // Top drivers by earnings
  const topDrivers = await Booking.aggregate([
    {
      $match: {
        status: "COMPLETED",
        createdAt: { $gte: startDate, $lte: endDate },
        driverId: { $exists: true },
      },
    },
    {
      $group: {
        _id: "$driverId",
        tripCount: { $sum: 1 },
        totalEarnings: { $sum: "$finalFare" },
        avgRating: { $avg: "$rating" },
      },
    },
    { $sort: { totalEarnings: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "drivers",
        localField: "_id",
        foreignField: "_id",
        as: "driver",
      },
    },
    {
      $project: {
        driver: { $arrayElemAt: ["$driver", 0] },
        tripCount: 1,
        totalEarnings: 1,
        avgRating: 1,
      },
    },
  ]);

  // Driver status distribution
  const statusDistribution = await Driver.aggregate([
    { $match: { isDeleted: false } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]);

  res.locals.data = {
    topDrivers,
    statusDistribution,
  };
};

/**
 * Top cities by orders/revenue (derived from driver.city on completed bookings)
 */
export const getCitiesReport = async (req: Request, res: Response) => {
  const range = (req.query.range as RangeKey) || "30D";
  const { start, end } = resolveRange(range);

  const cities = await Booking.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end }, driverId: { $exists: true } } },
    {
      $lookup: {
        from: "drivers",
        localField: "driverId",
        foreignField: "_id",
        as: "driver",
      },
    },
    { $unwind: { path: "$driver", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { $ifNull: ["$driver.city", "Unknown"] },
        orders: { $sum: 1 },
        revenue: {
          $sum: {
            $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", 0],
          },
        },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
        },
      },
    },
    { $sort: { orders: -1 } },
    { $limit: 10 },
  ]);

  const totalOrders = cities.reduce((sum, c) => sum + c.orders, 0);
  const enriched = cities.map((c) => ({
    city: c._id || "Unknown",
    orders: c.orders,
    revenue: c.revenue || 0,
    completed: c.completed,
    sharePct:
      totalOrders > 0 ? Math.round((c.orders / totalOrders) * 1000) / 10 : 0,
  }));

  res.locals.data = { range, cities: enriched };
};

/**
 * Top categories (vehicle types) by orders/revenue
 */
export const getCategoriesReport = async (req: Request, res: Response) => {
  const range = (req.query.range as RangeKey) || "30D";
  const { start, end } = resolveRange(range);

  const categories = await Booking.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $lookup: {
        from: "vehicletypes",
        localField: "vehicleTypeId",
        foreignField: "_id",
        as: "vt",
      },
    },
    { $unwind: { path: "$vt", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { $ifNull: ["$vt.name", "Other"] },
        orders: { $sum: 1 },
        revenue: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", 0] },
        },
      },
    },
    { $sort: { orders: -1 } },
  ]);

  const totalOrders = categories.reduce((sum, c) => sum + c.orders, 0);
  const enriched = categories.map((c) => ({
    name: c._id || "Other",
    orders: c.orders,
    revenue: c.revenue || 0,
    sharePct:
      totalOrders > 0 ? Math.round((c.orders / totalOrders) * 1000) / 10 : 0,
  }));

  res.locals.data = { range, categories: enriched };
};

/**
 * Top enterprise partners by orders/revenue
 */
export const getEnterprisesReport = async (req: Request, res: Response) => {
  const range = (req.query.range as RangeKey) || "30D";
  const { start, end } = resolveRange(range);

  const enterprises = await Booking.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lte: end },
        enterpriseId: { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: "$enterpriseId",
        orders: { $sum: 1 },
        revenue: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", 0] },
        },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
        },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "enterprises",
        localField: "_id",
        foreignField: "_id",
        as: "enterprise",
      },
    },
    { $unwind: { path: "$enterprise", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 1,
        orders: 1,
        revenue: 1,
        completed: 1,
        name: "$enterprise.companyName",
        city: "$enterprise.city",
        status: "$enterprise.status",
      },
    },
  ]);

  res.locals.data = { range, enterprises };
};

/**
 * Ops metrics: avg delivery time, on-time %, cancellation %, avg order value, driver utilization
 */
export const getOpsMetrics = async (req: Request, res: Response) => {
  const range = (req.query.range as RangeKey) || "30D";
  const { start, end } = resolveRange(range);

  const [aggregate, approvedDrivers, onlineDrivers] = await Promise.all([
    Booking.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] },
          },
          revenue: {
            $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", 0] },
          },
          avgOrderValue: {
            $avg: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", null] },
          },
          onTime: {
            $sum: {
              $cond: [{ $eq: ["$deliveryPerformance.wasOnTime", true] }, 1, 0],
            },
          },
          onTimeTracked: {
            $sum: {
              $cond: [
                { $ne: ["$deliveryPerformance.wasOnTime", null] },
                1,
                0,
              ],
            },
          },
          avgDeliveryMinutes: {
            $avg: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "COMPLETED"] },
                    { $ne: ["$completedAt", null] },
                  ],
                },
                {
                  $divide: [
                    { $subtract: ["$completedAt", "$createdAt"] },
                    1000 * 60,
                  ],
                },
                null,
              ],
            },
          },
        },
      },
    ]),
    Driver.countDocuments({ isDeleted: false, status: "approved" }),
    Driver.countDocuments({ isDeleted: false, status: "approved", isOnline: true }),
  ]);

  const a = aggregate[0] || {
    total: 0,
    completed: 0,
    cancelled: 0,
    revenue: 0,
    avgOrderValue: 0,
    onTime: 0,
    onTimeTracked: 0,
    avgDeliveryMinutes: 0,
  };

  res.locals.data = {
    range,
    totalOrders: a.total,
    completedOrders: a.completed,
    cancelledOrders: a.cancelled,
    revenue: a.revenue || 0,
    avgOrderValue: Math.round(a.avgOrderValue || 0),
    cancellationRatePct:
      a.total > 0 ? Math.round((a.cancelled / a.total) * 1000) / 10 : 0,
    onTimeRatePct:
      a.onTimeTracked > 0
        ? Math.round((a.onTime / a.onTimeTracked) * 1000) / 10
        : 0,
    avgDeliveryMinutes: Math.round(a.avgDeliveryMinutes || 0),
    driverUtilizationPct:
      approvedDrivers > 0
        ? Math.round((onlineDrivers / approvedDrivers) * 1000) / 10
        : 0,
    approvedDrivers,
    onlineDrivers,
  };
};

/**
 * Business snapshot time series:
 * buckets of revenue / orders / new customers / new drivers / avg rating / cancel rate
 */
export const getSnapshot = async (req: Request, res: Response) => {
  const range = (req.query.range as RangeKey) || "30D";
  const { start, end, format } = resolveRange(range);

  const [bookingSeries, userSeries, driverSeries] = await Promise.all([
    Booking.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format, date: "$createdAt" } },
          orders: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] },
          },
          revenue: {
            $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", 0] },
          },
          avgRating: { $avg: "$rating" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    User.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, isDeleted: false } },
      {
        $group: {
          _id: { $dateToString: { format, date: "$createdAt" } },
          customers: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Driver.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, isDeleted: false } },
      {
        $group: {
          _id: { $dateToString: { format, date: "$createdAt" } },
          drivers: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // Merge into a unified label set
  const labelSet = new Set<string>();
  bookingSeries.forEach((b) => labelSet.add(b._id));
  userSeries.forEach((u) => labelSet.add(u._id));
  driverSeries.forEach((d) => labelSet.add(d._id));
  const labels = Array.from(labelSet).sort();

  const bookingMap = new Map(bookingSeries.map((b: any) => [b._id, b]));
  const userMap = new Map(userSeries.map((u: any) => [u._id, u]));
  const driverMap = new Map(driverSeries.map((d: any) => [d._id, d]));

  const revenue: number[] = [];
  const orders: number[] = [];
  const customers: number[] = [];
  const drivers: number[] = [];
  const avgRating: number[] = [];
  const cancelRate: number[] = [];

  labels.forEach((label) => {
    const b: any = bookingMap.get(label);
    const u: any = userMap.get(label);
    const d: any = driverMap.get(label);
    revenue.push(b?.revenue || 0);
    orders.push(b?.orders || 0);
    customers.push(u?.customers || 0);
    drivers.push(d?.drivers || 0);
    avgRating.push(Math.round((b?.avgRating || 0) * 10) / 10);
    cancelRate.push(
      b?.orders > 0 ? Math.round((b.cancelled / b.orders) * 1000) / 10 : 0,
    );
  });

  res.locals.data = {
    range,
    labels,
    series: {
      revenue,
      orders,
      customers,
      drivers,
      avgRating,
      cancelRate,
    },
  };
};
