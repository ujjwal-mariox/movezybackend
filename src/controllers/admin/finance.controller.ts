import { Request, Response } from "express";
import mongoose from "mongoose";

// GET /admin/finance/overview
export const getFinanceOverview = async (req: Request, res: Response) => {
  const { period = "month" } = req.query;
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = { error: "Database not connected" };
    return;
  }

  const now = new Date();
  let startDate: Date;
  switch (period) {
    case "week":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "year":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  try {
    const bookingsCollection = db.collection("bookings");

    const [revenueAgg, refundAgg, commissionAgg, paymentMethods, dailyRevenue] =
      await Promise.all([
        // Total revenue. NOTE: booking status is stored UPPERCASE ("COMPLETED")
        // and the amount lives in `finalFare` (a number). The previous filters
        // used lowercase ["completed","delivered"] and `$fare.totalFare`, which
        // match NOTHING in the real data — so the whole Finance page read ₹0.
        bookingsCollection
          .aggregate([
            {
              $match: {
                createdAt: { $gte: startDate },
                status: "COMPLETED",
              },
            },
            {
              $group: {
                _id: null,
                grossRevenue: { $sum: "$finalFare" },
                // Real commission, frozen per booking at completion. This page
                // used to derive it as a flat 20% of gross — a number the
                // platform was not actually taking, since no commission was
                // deducted from driver payouts at all.
                realCommission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
                totalOrders: { $sum: 1 },
                avgOrderValue: { $avg: "$finalFare" },
              },
            },
          ])
          .toArray(),

        // Total refunds — flat `refundAmount` / `refundStatus` on the booking.
        bookingsCollection
          .aggregate([
            {
              $match: {
                createdAt: { $gte: startDate },
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

        // Commission is stored per booking now (commissionAmount, frozen at
        // completion), so this returns gross and the real commission is summed
        // alongside it rather than approximated afterwards.
        bookingsCollection
          .aggregate([
            {
              $match: {
                createdAt: { $gte: startDate },
                status: "COMPLETED",
              },
            },
            {
              $group: {
                _id: null,
                grossForCommission: { $sum: "$finalFare" },
              },
            },
          ])
          .toArray(),

        // Payment method breakdown
        bookingsCollection
          .aggregate([
            {
              $match: {
                createdAt: { $gte: startDate },
                status: "COMPLETED",
              },
            },
            {
              $group: {
                _id: "$paymentMethod",
                count: { $sum: 1 },
                total: { $sum: "$finalFare" },
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
                createdAt: { $gte: startDate },
                status: "COMPLETED",
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                },
                revenue: { $sum: "$finalFare" },
                commission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
                orders: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray(),
      ]);

    const gross = revenueAgg[0]?.grossRevenue || 0;
    // What was actually retained, summed from each booking's frozen
    // commissionAmount — not a flat percentage of gross applied after the fact.
    const commission = Math.round(revenueAgg[0]?.realCommission || 0);
    const refunds = refundAgg[0]?.totalRefunds || 0;

    // The chart's commission line now comes from the same real figure.
    const dailyRevenueWithCommission = (dailyRevenue || []).map((d: any) => ({
      ...d,
      commission: Math.round(d.commission || 0),
    }));

    res.locals.data = {
      summary: {
        grossRevenue: gross,
        netRevenue: gross - refunds,
        totalCommission: commission,
        totalRefunds: refunds,
        refundCount: refundAgg[0]?.refundCount || 0,
        refundRatio:
          revenueAgg[0]?.totalOrders > 0
            ? ((refundAgg[0]?.refundCount || 0) / revenueAgg[0].totalOrders) * 100
            : 0,
        totalOrders: revenueAgg[0]?.totalOrders || 0,
        avgOrderValue: revenueAgg[0]?.avgOrderValue || 0,
      },
      paymentMethods,
      dailyRevenue: dailyRevenueWithCommission,
      period,
    };
  } catch (err) {
    // Rethrow rather than answering 200 with a zero-filled summary. A failed
    // aggregation used to be indistinguishable over the wire from a genuine
    // month of no revenue, so an outage rendered as a real ₹0 finance page.
    // ErrorHandlerMiddleware turns this into an error response the client can
    // tell apart from data.
    console.error("[Finance] Overview error:", err);
    throw err;
  }
};

// Dead: GET /admin/finance/payouts is served by PayoutController.listPayouts
// (admin.routes.ts). Nothing routes or imports this. Kept only because deleting
// it is a separate change from the correctness pass; do not wire it up — the
// payout lifecycle (approve/pay separation of duties) lives in PayoutController.
export const getPayouts = async (req: Request, res: Response) => {
  const { page = 1, limit = 50, status, driverId } = req.query;
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = { payouts: [], pagination: { total: 0 } };
    return;
  }

  try {
    const filter: any = {};
    if (status) filter.status = status;
    if (driverId) filter.driverId = new mongoose.Types.ObjectId(driverId as string);

    const payoutsCollection = db.collection("payouts");
    const skip = (Number(page) - 1) * Number(limit);

    const [payouts, total] = await Promise.all([
      payoutsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .toArray(),
      payoutsCollection.countDocuments(filter),
    ]);

    res.locals.data = {
      payouts,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    };
  } catch (err) {
    // An empty payout queue and a failed one look identical to the client, and
    // the difference is whether drivers are owed money nobody can see.
    console.error("[Finance] Payouts error:", err);
    throw err;
  }
};

// GET /admin/finance/driver-earnings
// Real per-driver earnings derived from bookings (replaces admin MOCK_DRIVER_EARNINGS).
export const getDriverEarnings = async (req: Request, res: Response) => {
  const { period = "month", limit = 50 } = req.query;
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = { drivers: [] };
    return;
  }

  const now = new Date();
  let startDate: Date;
  switch (period) {
    case "today":
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "year":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case "month":
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
  }

  try {
    const bookings = db.collection("bookings");

    // Per driver, within the period: completed trips + gross earnings + distance,
    // plus total-assigned and driver-cancelled counts for cancellation rate.
    const rows = await bookings
      .aggregate([
        {
          $match: {
            driverId: { $ne: null },
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: "$driverId",
            trips: {
              $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
            },
            earnings: {
              // driverEarnings, not finalFare: this figure prefills the
              // payout dialog. The gross fare includes the customer's GST and
              // the platform commission — paying it out would overpay every
              // driver by roughly a quarter. Legacy trips completed before
              // driverEarnings existed fall back to the gross so their rows
              // aren't zero, but anything settled recently uses the real net.
              $sum: {
                $cond: [
                  { $eq: ["$status", "COMPLETED"] },
                  {
                    $ifNull: [
                      "$driverEarnings",
                      { $ifNull: ["$finalFare", "$fare"] },
                    ],
                  },
                  0,
                ],
              },
            },
            distance: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "COMPLETED"] },
                  { $ifNull: ["$distanceKm", 0] },
                  0,
                ],
              },
            },
            totalAssigned: { $sum: 1 },
            cancelledByDriver: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "CANCELLED"] },
                      { $eq: ["$cancelledBy", "DRIVER"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $match: { trips: { $gt: 0 } } },
        { $sort: { earnings: -1 } },
        { $limit: Number(limit) },
        {
          $lookup: {
            from: "drivers",
            localField: "_id",
            foreignField: "_id",
            as: "driver",
          },
        },
        { $unwind: { path: "$driver", preserveNullAndEmptyArrays: true } },
      ])
      .toArray();

    const drivers = rows.map((r: any) => ({
      id: String(r._id),
      name: r.driver?.fullName || r.driver?.name || "Unknown Driver",
      mobileNumber: r.driver?.mobileNumber || "",
      trips: r.trips,
      distance: Math.round((r.distance || 0) * 10) / 10,
      earnings: Math.round(r.earnings || 0),
      cancellation:
        r.totalAssigned > 0
          ? Math.round((r.cancelledByDriver / r.totalAssigned) * 1000) / 10
          : 0,
      // Real payout status isn't tracked yet; default to pending until a payout
      // record exists for this driver+period.
      payoutStatus: "pending" as const,
    }));

    res.locals.data = { drivers, period };
  } catch (err) {
    // "No driver earned anything" is a real answer this endpoint can give, so
    // it must not also be the failure answer — the payout table is built from
    // this list.
    console.error("[Finance] driver-earnings error:", err);
    throw err;
  }
};

// GET /admin/finance/cod-summary
export const getCODSummary = async (req: Request, res: Response) => {
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = {};
    return;
  }

  try {
    const bookingsCollection = db.collection("bookings");
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [codStats, pendingCOD, driverCODBalances] = await Promise.all([
      bookingsCollection
        .aggregate([
          {
            $match: {
              paymentMethod: "CASH",
              status: "COMPLETED",
              createdAt: { $gte: sevenDaysAgo },
            },
          },
          {
            $group: {
              _id: null,
              totalCollected: { $sum: "$finalFare" },
              totalOrders: { $sum: 1 },
            },
          },
        ])
        .toArray(),

      bookingsCollection
        .aggregate([
          {
            $match: {
              paymentMethod: "CASH",
              status: "COMPLETED",
              "codSettlement.status": { $ne: "settled" },
            },
          },
          {
            $group: {
              _id: null,
              pendingAmount: { $sum: "$finalFare" },
              pendingOrders: { $sum: 1 },
            },
          },
        ])
        .toArray(),

      bookingsCollection
        .aggregate([
          {
            $match: {
              paymentMethod: "CASH",
              status: "COMPLETED",
              "codSettlement.status": { $ne: "settled" },
            },
          },
          {
            $group: {
              _id: "$driverId",
              floatingCash: { $sum: "$finalFare" },
              orderCount: { $sum: 1 },
            },
          },
          { $sort: { floatingCash: -1 } },
          { $limit: 20 },
          // Who a balance belongs to, in words. The table used to render the
          // raw ObjectId, which nobody can act on — the settle flow needs the
          // admin to recognise the driver.
          {
            $lookup: {
              from: "drivers",
              localField: "_id",
              foreignField: "_id",
              pipeline: [
                { $project: { fullName: 1, driverCode: 1, mobileNumber: 1 } },
              ],
              as: "driver",
            },
          },
          {
            $addFields: {
              driverName: { $first: "$driver.fullName" },
              driverCode: { $first: "$driver.driverCode" },
              driverPhone: { $first: "$driver.mobileNumber" },
            },
          },
          { $project: { driver: 0 } },
        ])
        .toArray(),
    ]);

    res.locals.data = {
      totalCollected: codStats[0]?.totalCollected || 0,
      totalCODOrders: codStats[0]?.totalOrders || 0,
      pendingSettlement: pendingCOD[0]?.pendingAmount || 0,
      pendingOrders: pendingCOD[0]?.pendingOrders || 0,
      driverCODBalances,
    };
  } catch (err) {
    // Unsettled COD is cash drivers are holding on the platform's behalf.
    // Reporting ₹0 because the aggregation failed says "nobody owes us
    // anything", which is the most expensive possible wrong answer here.
    console.error("[Finance] COD summary error:", err);
    throw err;
  }
};

// GET /admin/finance/export
export const exportFinanceData = async (req: Request, res: Response) => {
  const { type = "revenue", format = "csv" } = req.query;
  // Return data in a format that can be converted to CSV/XLSX on frontend
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = { rows: [] };
    return;
  }

  try {
    const bookingsCollection = db.collection("bookings");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let rows: any[] = [];

    if (type === "revenue") {
      rows = await bookingsCollection
        .find({
          status: "COMPLETED",
          createdAt: { $gte: thirtyDaysAgo },
        })
        .project({
          bookingNumber: 1,
          createdAt: 1,
          finalFare: 1,
          paymentMethod: 1,
          status: 1,
        })
        .sort({ createdAt: -1 })
        .limit(5000)
        .toArray();
    } else if (type === "payouts") {
      const payoutsCollection = db.collection("payouts");
      rows = await payoutsCollection
        .find({ createdAt: { $gte: thirtyDaysAgo } })
        .sort({ createdAt: -1 })
        .limit(5000)
        .toArray();
    }

    res.locals.data = { rows, format, type };
  } catch {
    res.locals.data = { rows: [], format, type };
  }
};

// GET /admin/dashboard/alerts
export const getDashboardAlerts = async (req: Request, res: Response) => {
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = [];
    return;
  }

  try {
    const alerts: any[] = [];

    const bookingsCollection = db.collection("bookings");
    const driversCollection = db.collection("drivers");
    const sosCollection = db.collection("sosalerts");

    // 1. Unassigned orders
    const unassignedCount = await bookingsCollection.countDocuments({
      status: "pending",
      driverId: { $exists: false },
    });
    if (unassignedCount > 0) {
      alerts.push({
        severity: "warning",
        type: "unassigned_orders",
        message: `${unassignedCount} orders are waiting for driver assignment`,
        count: unassignedCount,
        link: "/admin/orders?status=pending",
      });
    }

    // 2. Active SOS alerts
    const activeSOS = await sosCollection.countDocuments({
      status: { $in: ["ACTIVE", "RESPONDED"] },
    });
    if (activeSOS > 0) {
      alerts.push({
        severity: "critical",
        type: "active_sos",
        message: "Emergency alerts require immediate attention",
        count: activeSOS,
        link: "/admin/sos",
      });
    }

    // 3. Expiring driver documents (within 30 days)
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expiringDocs = await driversCollection.countDocuments({
      "kyc.drivingLicense.expiryDate": {
        $lte: thirtyDaysFromNow,
        $gte: new Date(),
      },
      status: "approved",
    });
    if (expiringDocs > 0) {
      alerts.push({
        severity: "warning",
        type: "expiring_documents",
        message: `${expiringDocs} driver license(s) expiring within 30 days`,
        count: expiringDocs,
        link: "/admin/riders?tab=compliance",
      });
    }

    // 4. High cancellation rate today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayBookings = await bookingsCollection.countDocuments({
      createdAt: { $gte: today },
    });
    const todayCancellations = await bookingsCollection.countDocuments({
      createdAt: { $gte: today },
      status: "cancelled",
    });
    const cancellationRate =
      todayBookings > 0 ? (todayCancellations / todayBookings) * 100 : 0;
    if (cancellationRate > 20 && todayBookings > 10) {
      alerts.push({
        severity: "warning",
        type: "cancellation_spike",
        message: `Today's cancellation rate is ${cancellationRate.toFixed(1)}% (${todayCancellations}/${todayBookings})`,
        count: todayCancellations,
        link: "/admin/orders?status=cancelled",
      });
    }

    // 5. Idle online drivers (no trip in 7 days but marked online)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const idleDrivers = await driversCollection.countDocuments({
      isOnline: true,
      lastTripDate: { $lt: sevenDaysAgo },
      status: "approved",
    });
    if (idleDrivers > 0) {
      alerts.push({
        severity: "info",
        type: "idle_drivers",
        message: `${idleDrivers} driver(s) online but no trips in 7+ days`,
        count: idleDrivers,
        link: "/admin/riders?filter=idle",
      });
    }

    res.locals.data = alerts;
  } catch (err) {
    console.error("[Dashboard] Alerts error:", err);
    res.locals.data = [];
  }
};

// GET /admin/dashboard/live-stats
export const getLiveStats = async (req: Request, res: Response) => {
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = {};
    return;
  }

  try {
    const bookingsCollection = db.collection("bookings");
    const driversCollection = db.collection("drivers");
    const usersCollection = db.collection("users");
    const sosCollection = db.collection("sosalerts");

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // "vs yesterday" must compare the same slice of the day — a full 24h of
    // yesterday against a part-day today would report a fake collapse every
    // morning. Yesterday is therefore cut at the same clock time as now.
    const yesterdayStart = new Date(today);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdaySameTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalOrders,
      liveOrders,
      pendingOrders,
      todayRevenue,
      activeDrivers,
      totalDrivers,
      activeSOS,
      totalUsers,
      todayCancelled,
      todayTotal,
      delayedOrders,
      driversOnTrip,
      completedToday,
      pendingToday,
      yesterdayRevenue,
      yesterdayCancelled,
      yesterdayOrders,
    ] = await Promise.all([
      bookingsCollection.countDocuments({}),
      bookingsCollection.countDocuments({
        // Real status enum is UPPERCASE: active-trip states.
        status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
      }),
      bookingsCollection.countDocuments({ status: "SEARCHING" }),
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: today },
              status: "COMPLETED",
            },
          },
          { $group: { _id: null, total: { $sum: "$finalFare" } } },
        ])
        .toArray(),
      driversCollection.countDocuments({ isOnline: true, status: "approved" }),
      driversCollection.countDocuments({ status: "approved" }),
      sosCollection.countDocuments({
        status: { $in: ["ACTIVE", "RESPONDED"] },
      }),
      usersCollection.countDocuments({ isDeleted: { $ne: true } }),
      bookingsCollection.countDocuments({
        createdAt: { $gte: today },
        status: "CANCELLED",
      }),
      bookingsCollection.countDocuments({ createdAt: { $gte: today } }),
      // Active trips past their estimated drop time — the dashboard's
      // "Delayed Orders" card read a field this endpoint never returned.
      bookingsCollection.countDocuments({
        status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
        estimatedDropTime: { $ne: null, $lt: new Date() },
      }),
      // Online drivers currently carrying a booking. Without this the driver
      // performance donut had no on-trip-vs-idle split to render and showed an
      // explicit "not available" state rather than guessing from utilisation.
      driversCollection.countDocuments({
        isOnline: true,
        status: "approved",
        currentBookingId: { $ne: null },
      }),
      // Same-day outcome counts for the "Today" bar chart, which read two
      // fields this endpoint never returned.
      bookingsCollection.countDocuments({
        createdAt: { $gte: today },
        status: "COMPLETED",
      }),
      bookingsCollection.countDocuments({
        createdAt: { $gte: today },
        status: "SEARCHING",
      }),
      // Yesterday, up to this time of day — the comparison basis for the KPI
      // trend text. Previously the dashboard had no comparison data at all, so
      // its trend arrows were removed rather than invented.
      bookingsCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: yesterdayStart, $lt: yesterdaySameTime },
              status: "COMPLETED",
            },
          },
          { $group: { _id: null, total: { $sum: "$finalFare" } } },
        ])
        .toArray(),
      bookingsCollection.countDocuments({
        createdAt: { $gte: yesterdayStart, $lt: yesterdaySameTime },
        status: "CANCELLED",
      }),
      bookingsCollection.countDocuments({
        createdAt: { $gte: yesterdayStart, $lt: yesterdaySameTime },
      }),
    ]);

    const failureRate =
      todayTotal > 0 ? ((todayCancelled / todayTotal) * 100).toFixed(1) : "0.0";
    const utilization =
      totalDrivers > 0
        ? ((activeDrivers / totalDrivers) * 100).toFixed(1)
        : "0.0";

    res.locals.data = {
      totalOrders,
      liveOrders,
      pendingOrders,
      todayRevenue: todayRevenue[0]?.total || 0,
      activeDrivers,
      totalDrivers,
      activeSOS,
      totalUsers,
      failureRate: Number(failureRate),
      driverUtilization: Number(utilization),
      delayedOrders,
      cancelledToday: todayCancelled,
      driversOnTrip,
      // Genuinely free to take a job: online, approved, and not already
      // carrying a booking. `activeDrivers` counts everyone online including
      // drivers mid-trip, so labelling that "Available" overstated dispatch
      // capacity — this is the number that can actually be assigned.
      availableDrivers: Math.max(activeDrivers - driversOnTrip, 0),
      completedToday,
      pendingToday,
      // Same-slice-of-day yesterday figures, for the KPI trend text.
      yesterdayRevenue: yesterdayRevenue[0]?.total || 0,
      yesterdayCancelled,
      yesterdayOrders,
      todayOrders: todayTotal,
    };
  } catch (err) {
    // Zero-filled stats are indistinguishable from a genuinely idle platform —
    // "0 live orders, 0 drivers online, 0 SOS" is exactly what an operator does
    // not want to be told during an outage. Fail loudly instead.
    console.error("[Dashboard] Live stats error:", err);
    throw err;
  }
};

// GET /admin/dashboard/event-timeline
export const getEventTimeline = async (req: Request, res: Response) => {
  const { limit = 30 } = req.query;
  const db = mongoose.connection.db;
  if (!db) {
    res.locals.data = [];
    return;
  }

  try {
    // Pull recent events from audit logs + bookings + SOS
    const auditLogCollection = db.collection("auditlogs");

    const recentEvents = await auditLogCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .project({
        action: 1,
        module: 1,
        description: 1,
        adminName: 1,
        createdAt: 1,
        targetType: 1,
        targetId: 1,
      })
      .toArray();

    const events = recentEvents.map((e: any) => ({
      _id: e._id.toString(),
      action: e.action,
      module: e.module,
      description: e.description,
      adminName: e.adminName || "System",
      createdAt: e.createdAt,
    }));

    res.locals.data = events;
  } catch {
    res.locals.data = [];
  }
};
