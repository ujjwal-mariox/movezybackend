import { Request, Response } from "express";
import mongoose from "mongoose";
import Driver from "../../models/driver.model";
import DriverKYC from "../../models/driver-kyc.model";
import Booking from "../../models/booking.model";

/**
 * GET /admin/drivers/:id/enhanced
 * Get enhanced driver details with all metrics
 */
export const getEnhancedDriverDetails = async (req: Request, res: Response) => {
  const { id } = req.params;
  const db = mongoose.connection.db;

  const driver = await Driver.findById(id);
  if (!driver) {
    return res.status(404).json({ success: false, message: "Driver not found" });
  }

  const kyc = await DriverKYC.findOne({ driverId: id });

  // Get document expiry status (traffic light)
  const documentStatus = getDocumentExpiryStatus(kyc);

  // Get COD balance
  const codBalance = await getCODBalance(id, db);

  // Get weekly earnings (last 4 weeks)
  const weeklyEarnings = await getWeeklyEarnings(id);

  // Get reassignment count
  const reassignmentCount = await getReassignmentCount(id);

  // Get performance metrics
  const performanceMetrics = await getPerformanceMetrics(id);

  res.locals.data = {
    driver,
    kyc,
    documentStatus,
    codBalance,
    weeklyEarnings,
    reassignmentCount,
    performanceMetrics,
  };
};

/**
 * GET /admin/drivers/:id/cod-balance
 * Get driver's COD balance details
 */
export const getDriverCODBalance = async (req: Request, res: Response) => {
  const { id } = req.params;
  const db = mongoose.connection.db;

  if (!db) {
    res.locals.data = { error: "Database not connected" };
    return;
  }

  const codData = await getCODBalance(id, db);

  // Get recent COD orders
  const recentCODOrders = await Booking.find({
    driverId: id,
    paymentMethod: "CASH",
    status: "COMPLETED",
  })
    .select("bookingNumber finalFare completedAt codSettlement")
    .sort({ completedAt: -1 })
    .limit(20)
    .lean();

  res.locals.data = {
    ...codData,
    recentOrders: recentCODOrders,
  };
};

/**
 * GET /admin/drivers/:id/weekly-earnings
 * Get weekly earnings breakdown
 */
export const getDriverWeeklyEarnings = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { weeks = 4 } = req.query;

  const weeklyData = await getWeeklyEarnings(id, Number(weeks));

  res.locals.data = { weeklyEarnings: weeklyData };
};

/**
 * GET /admin/drivers/:id/documents/status
 * Get document expiry status with traffic light
 */
export const getDriverDocumentStatus = async (req: Request, res: Response) => {
  const { id } = req.params;

  const kyc = await DriverKYC.findOne({ driverId: id });
  if (!kyc) {
    return res.status(404).json({ success: false, message: "KYC documents not found" });
  }

  const status = getDocumentExpiryStatus(kyc);

  res.locals.data = { documentStatus: status };
};

/**
 * GET /admin/drivers/:id/reassignments
 * Get reassignment history and count
 */
export const getDriverReassignments = async (req: Request, res: Response) => {
  const { id } = req.params;

  const count = await getReassignmentCount(id);

  // NOTE: reassignedFrom/reassignedAt/reassignmentReason are not (yet) part of the
  // Booking schema, so there is no ref to populate and no reassignment history to
  // return. Query defensively and return an empty list rather than throwing (500/400).
  let reassignedBookings: unknown[] = [];
  try {
    reassignedBookings = await Booking.find({
      driverId: new mongoose.Types.ObjectId(id),
      reassignedFrom: { $exists: true, $ne: null },
    })
      .select("bookingNumber status reassignedFrom reassignedAt reassignmentReason")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
  } catch (err) {
    console.error("[Reassignments] query failed:", err);
    reassignedBookings = [];
  }

  res.locals.data = {
    reassignmentCount: count,
    reassignedBookings,
  };
};

/**
 * GET /admin/drivers/cod-summary
 * Get COD summary for all drivers
 */
export const getAllDriversCODSummary = async (req: Request, res: Response) => {
  const { page = 0, limit = 50, minBalance = 0 } = req.query;
  const db = mongoose.connection.db;

  if (!db) {
    res.locals.data = { error: "Database not connected" };
    return;
  }

  try {
    const bookingsCollection = db.collection("bookings");

    const codBalances = await bookingsCollection
      .aggregate([
        {
          $match: {
            paymentMethod: "CASH",
            status: { $in: ["COMPLETED", "completed", "delivered"] },
            $or: [
              { "codSettlement.status": { $ne: "settled" } },
              { codSettlement: { $exists: false } },
            ],
          },
        },
        {
          $group: {
            _id: "$driverId",
            floatingCash: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
            orderCount: { $sum: 1 },
            oldestOrderDate: { $min: "$completedAt" },
          },
        },
        { $match: { floatingCash: { $gte: Number(minBalance) } } },
        { $sort: { floatingCash: -1 } },
        { $skip: Number(page) * Number(limit) },
        { $limit: Number(limit) },
        {
          $lookup: {
            from: "drivers",
            localField: "_id",
            foreignField: "_id",
            as: "driver",
          },
        },
        { $unwind: "$driver" },
        {
          $project: {
            driverId: "$_id",
            driverName: "$driver.fullName",
            driverPhone: "$driver.mobileNumber",
            floatingCash: 1,
            orderCount: 1,
            oldestOrderDate: 1,
            daysOutstanding: {
              $divide: [
                { $subtract: [new Date(), "$oldestOrderDate"] },
                1000 * 60 * 60 * 24,
              ],
            },
          },
        },
      ])
      .toArray();

    // Get totals
    const totals = await bookingsCollection
      .aggregate([
        {
          $match: {
            paymentMethod: "CASH",
            status: { $in: ["COMPLETED", "completed", "delivered"] },
            $or: [
              { "codSettlement.status": { $ne: "settled" } },
              { codSettlement: { $exists: false } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            totalFloatingCash: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
            totalOrders: { $sum: 1 },
            uniqueDrivers: { $addToSet: "$driverId" },
          },
        },
        {
          $project: {
            totalFloatingCash: 1,
            totalOrders: 1,
            driverCount: { $size: "$uniqueDrivers" },
          },
        },
      ])
      .toArray();

    res.locals.data = {
      drivers: codBalances,
      totals: totals[0] || { totalFloatingCash: 0, totalOrders: 0, driverCount: 0 },
      page: Number(page),
      limit: Number(limit),
    };
  } catch (err) {
    console.error("[Driver] COD summary error:", err);
    res.locals.data = { error: "Failed to fetch COD summary" };
  }
};

/**
 * PUT /admin/drivers/:id/cod/settle
 * Settle COD for a driver
 */
export const settleCOD = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, transactionId, notes } = req.body;

  // Get unsettled COD orders
  const unsettledOrders = await Booking.find({
    driverId: id,
    paymentMethod: "CASH",
    status: "COMPLETED",
    $or: [
      { "codSettlement.status": { $ne: "settled" } },
      { codSettlement: { $exists: false } },
    ],
  }).sort({ completedAt: 1 });

  if (unsettledOrders.length === 0) {
    return res.status(400).json({ success: false, message: "No unsettled COD orders found" });
  }

  // Settle orders up to the amount
  let remainingAmount = amount;
  const settledOrders: string[] = [];

  for (const order of unsettledOrders) {
    if (remainingAmount <= 0) break;

    const orderAmount = order.finalFare || 0;
    order.codSettlement = {
      status: "settled",
      amount: orderAmount,
      settledAt: new Date(),
      settledBy: req.adminId ? new mongoose.Types.ObjectId(req.adminId) : undefined,
      transactionId,
      notes,
    };

    await order.save();
    if (order.bookingNumber) {
      settledOrders.push(order.bookingNumber);
    }
    remainingAmount -= orderAmount;
  }

  res.locals.data = {
    message: "COD settled successfully",
    settledOrders,
    settledAmount: amount - Math.max(0, remainingAmount),
    remainingBalance: Math.max(0, remainingAmount),
  };
};

/**
 * GET /admin/drivers/expiring-documents
 * Get list of drivers with expiring documents
 */
export const getExpiringDocuments = async (req: Request, res: Response) => {
  const { days = 30 } = req.query;
  const expiryDate = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);

  // Convert dates to ISO strings since expiryDate fields are stored as strings
  const expiryDateStr = expiryDate.toISOString().split("T")[0];
  const todayStr = new Date().toISOString().split("T")[0];

  const expiringKYC = await DriverKYC.find({
    "drivingLicense.expiryDate": { $lte: expiryDateStr, $gte: todayStr },
  })
    .populate("driverId", "fullName mobileNumber email status")
    .lean();

  const driversWithExpiry = expiringKYC.map((kyc) => {
    const expiringDocs: any[] = [];

    if (kyc.drivingLicense?.expiryDate && new Date(kyc.drivingLicense.expiryDate) <= expiryDate) {
      expiringDocs.push({
        type: "Driving License",
        expiryDate: kyc.drivingLicense.expiryDate,
        daysRemaining: Math.ceil(
          (new Date(kyc.drivingLicense.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        ),
      });
    }

    // Add other documents similarly...

    return {
      driver: kyc.driverId,
      expiringDocuments: expiringDocs,
    };
  });

  res.locals.data = {
    driversWithExpiringDocs: driversWithExpiry,
    total: driversWithExpiry.length,
    daysThreshold: Number(days),
  };
};

// Helper functions

async function getCODBalance(driverId: string, db: any) {
  if (!db) return { floatingCash: 0, pendingOrders: 0 };

  const bookingsCollection = db.collection("bookings");

  const result = await bookingsCollection
    .aggregate([
      {
        $match: {
          driverId: new mongoose.Types.ObjectId(driverId),
          paymentMethod: "CASH",
          status: { $in: ["COMPLETED", "completed", "delivered"] },
          $or: [
            { "codSettlement.status": { $ne: "settled" } },
            { codSettlement: { $exists: false } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          floatingCash: { $sum: { $ifNull: ["$finalFare", "$fare.totalFare"] } },
          pendingOrders: { $sum: 1 },
          oldestDate: { $min: "$completedAt" },
        },
      },
    ])
    .toArray();

  return {
    floatingCash: result[0]?.floatingCash || 0,
    pendingOrders: result[0]?.pendingOrders || 0,
    oldestOrderDate: result[0]?.oldestDate || null,
    daysOutstanding: result[0]?.oldestDate
      ? Math.ceil((Date.now() - new Date(result[0].oldestDate).getTime()) / (1000 * 60 * 60 * 24))
      : 0,
  };
}

async function getWeeklyEarnings(driverId: string, weeks: number = 4) {
  const results: any[] = [];
  const now = new Date();

  for (let i = 0; i < weeks; i++) {
    const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const earnings = await Booking.aggregate([
      {
        $match: {
          driverId: new mongoose.Types.ObjectId(driverId),
          status: "COMPLETED",
          completedAt: { $gte: weekStart, $lte: weekEnd },
        },
      },
      {
        $group: {
          _id: null,
          // What the driver earned: net of the platform's commission and the
          // customer's GST. This summed finalFare, which is the customer's
          // whole payment, so weekly "earnings" ran ~31% above what a payout
          // would ever settle.
          totalEarnings: { $sum: { $ifNull: ["$driverEarnings", 0] } },
          tripCount: { $sum: 1 },
          // Deliberately still gross: these are cash-vs-online COLLECTED
          // amounts and feed COD reasoning, so they must stay on the money that
          // actually changed hands. Renamed so the two bases cannot be confused.
          cashCollected: {
            $sum: { $cond: [{ $eq: ["$paymentMethod", "CASH"] }, "$finalFare", 0] },
          },
          onlineCollected: {
            $sum: { $cond: [{ $ne: ["$paymentMethod", "CASH"] }, "$finalFare", 0] },
          },
        },
      },
    ]);

    results.push({
      week: i + 1,
      weekStart,
      weekEnd,
      totalEarnings: earnings[0]?.totalEarnings || 0,
      tripCount: earnings[0]?.tripCount || 0,
      cashCollected: earnings[0]?.cashCollected || 0,
      onlineCollected: earnings[0]?.onlineCollected || 0,
    });
  }

  return results;
}

async function getReassignmentCount(driverId: string) {
  // reassignedFrom is not a defined schema path yet; guard against cast errors and
  // report zero reassignments rather than failing the whole driver-detail load.
  try {
    const [reassignedFrom, reassignedTo] = await Promise.all([
      Booking.countDocuments({ reassignedFrom: driverId }),
      Booking.countDocuments({
        driverId,
        reassignedFrom: { $exists: true, $ne: null },
      }),
    ]);

    return {
      reassignedFromDriver: reassignedFrom,
      reassignedToDriver: reassignedTo,
      total: reassignedFrom + reassignedTo,
    };
  } catch {
    return { reassignedFromDriver: 0, reassignedToDriver: 0, total: 0 };
  }
}

async function getPerformanceMetrics(driverId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const metrics = await Booking.aggregate([
    {
      $match: {
        driverId: new mongoose.Types.ObjectId(driverId),
        createdAt: { $gte: thirtyDaysAgo },
      },
    },
    {
      $group: {
        _id: null,
        totalTrips: { $sum: 1 },
        completedTrips: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
        },
        cancelledTrips: {
          $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] },
        },
        avgRating: { $avg: "$rating" },
        totalRevenue: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalFare", 0] },
        },
      },
    },
  ]);

  const data = metrics[0] || {};

  return {
    totalTrips: data.totalTrips || 0,
    completedTrips: data.completedTrips || 0,
    cancelledTrips: data.cancelledTrips || 0,
    completionRate: data.totalTrips > 0
      ? ((data.completedTrips / data.totalTrips) * 100).toFixed(1)
      : 0,
    avgRating: data.avgRating?.toFixed(2) || 0,
    totalRevenue: data.totalRevenue || 0,
    period: "30 days",
  };
}

function getDocumentExpiryStatus(kyc: any) {
  if (!kyc) {
    return {
      overall: "red",
      message: "No KYC documents found",
      documents: [],
    };
  }

  const today = new Date();
  const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const documents = [
    { type: "Driving License", expiry: kyc.drivingLicense?.expiryDate },
    { type: "Vehicle RC", expiry: kyc.vehicleRC?.expiryDate },
    { type: "Vehicle Insurance", expiry: kyc.vehicleInsurance?.expiryDate },
    { type: "Vehicle Fitness", expiry: kyc.vehicleFitness?.expiryDate },
    { type: "Vehicle Permit", expiry: kyc.vehiclePermit?.expiryDate },
  ]
    .filter((d) => d.expiry)
    .map((doc) => {
      const expiryDate = new Date(doc.expiry);
      let status: "green" | "yellow" | "red";
      let message: string;

      if (expiryDate < today) {
        status = "red";
        message = "Expired";
      } else if (expiryDate < sevenDays) {
        status = "red";
        message = "Expires within 7 days";
      } else if (expiryDate < thirtyDays) {
        status = "yellow";
        message = "Expires within 30 days";
      } else {
        status = "green";
        message = "Valid";
      }

      return {
        type: doc.type,
        expiryDate: doc.expiry,
        status,
        message,
        daysRemaining: Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)),
      };
    });

  // Overall status is the worst of all documents
  let overall: "green" | "yellow" | "red" = "green";
  if (documents.some((d) => d.status === "red")) overall = "red";
  else if (documents.some((d) => d.status === "yellow")) overall = "yellow";

  return {
    overall,
    message:
      overall === "red"
        ? "Critical: Documents expired or expiring soon"
        : overall === "yellow"
        ? "Warning: Documents expiring within 30 days"
        : "All documents valid",
    documents,
  };
}

/**
 * GET /admin/drivers/late-delivery-metrics
 * Get late delivery percentage across all drivers
 */
export const getLateDeliveryMetrics = async (req: Request, res: Response) => {
  const { days = 30 } = req.query;
  const startDate = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);

  try {
    // Get bookings with delivery performance tracking
    const metrics = await Booking.aggregate([
      {
        $match: {
          status: "COMPLETED",
          completedAt: { $gte: startDate },
          estimatedDropTime: { $exists: true },
        },
      },
      {
        $addFields: {
          isLate: {
            $cond: [
              { $gt: ["$completedAt", "$estimatedDropTime"] },
              true,
              false,
            ],
          },
          delayMs: {
            $cond: [
              { $gt: ["$completedAt", "$estimatedDropTime"] },
              { $subtract: ["$completedAt", "$estimatedDropTime"] },
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$driverId",
          totalDeliveries: { $sum: 1 },
          lateDeliveries: { $sum: { $cond: ["$isLate", 1, 0] } },
          totalDelayMinutes: { $sum: { $divide: ["$delayMs", 60000] } },
        },
      },
      {
        $lookup: {
          from: "drivers",
          localField: "_id",
          foreignField: "_id",
          as: "driver",
        },
      },
      { $unwind: "$driver" },
      {
        $project: {
          driverId: "$_id",
          driverName: "$driver.fullName",
          driverPhone: "$driver.mobileNumber",
          totalDeliveries: 1,
          lateDeliveries: 1,
          onTimeDeliveries: { $subtract: ["$totalDeliveries", "$lateDeliveries"] },
          lateDeliveryRate: {
            $multiply: [{ $divide: ["$lateDeliveries", "$totalDeliveries"] }, 100],
          },
          avgDelayMinutes: {
            $cond: [
              { $gt: ["$lateDeliveries", 0] },
              { $divide: ["$totalDelayMinutes", "$lateDeliveries"] },
              0,
            ],
          },
        },
      },
      { $sort: { lateDeliveryRate: -1 } },
    ]);

    // Get overall summary
    const summary = metrics.reduce(
      (acc, driver) => ({
        totalDeliveries: acc.totalDeliveries + driver.totalDeliveries,
        lateDeliveries: acc.lateDeliveries + driver.lateDeliveries,
        onTimeDeliveries: acc.onTimeDeliveries + driver.onTimeDeliveries,
      }),
      { totalDeliveries: 0, lateDeliveries: 0, onTimeDeliveries: 0 }
    );

    res.locals.data = {
      drivers: metrics,
      summary: {
        ...summary,
        overallLateRate:
          summary.totalDeliveries > 0
            ? ((summary.lateDeliveries / summary.totalDeliveries) * 100).toFixed(2)
            : 0,
        overallOnTimeRate:
          summary.totalDeliveries > 0
            ? ((summary.onTimeDeliveries / summary.totalDeliveries) * 100).toFixed(2)
            : 0,
      },
      period: `${days} days`,
    };
  } catch (err) {
    console.error("[Driver] Late delivery metrics error:", err);
    res.locals.data = { error: "Failed to fetch late delivery metrics" };
  }
};

/**
 * GET /admin/drivers/device-info
 * Get driver device info summary (battery, app version)
 */
export const getDeviceInfoSummary = async (req: Request, res: Response) => {
  try {
    const minAppVersion = "1.0.0"; // This should come from config

    const driversWithDeviceInfo = await Driver.find({
      "deviceInfo.lastUpdated": { $exists: true },
      isDeleted: false,
    })
      .select("fullName mobileNumber deviceInfo isOnline status")
      .sort({ "deviceInfo.lastUpdated": -1 })
      .lean();

    // Categorize by battery level
    const lowBattery = driversWithDeviceInfo.filter(
      (d) => d.deviceInfo?.batteryLevel && d.deviceInfo.batteryLevel < 20
    );
    const criticalBattery = driversWithDeviceInfo.filter(
      (d) => d.deviceInfo?.batteryLevel && d.deviceInfo.batteryLevel < 10
    );

    // Categorize by app version
    const outdatedAppDrivers = driversWithDeviceInfo.filter(
      (d) => d.deviceInfo?.appVersion && d.deviceInfo.appVersion < minAppVersion
    );

    // App version distribution
    const versionDistribution = driversWithDeviceInfo.reduce((acc: Record<string, number>, d) => {
      const version = d.deviceInfo?.appVersion || "unknown";
      acc[version] = (acc[version] || 0) + 1;
      return acc;
    }, {});

    // Platform distribution
    const platformDistribution = driversWithDeviceInfo.reduce((acc: Record<string, number>, d) => {
      const platform = d.deviceInfo?.platform || "unknown";
      acc[platform] = (acc[platform] || 0) + 1;
      return acc;
    }, {});

    res.locals.data = {
      drivers: driversWithDeviceInfo,
      summary: {
        totalWithDeviceInfo: driversWithDeviceInfo.length,
        lowBatteryCount: lowBattery.length,
        criticalBatteryCount: criticalBattery.length,
        outdatedAppCount: outdatedAppDrivers.length,
        minAppVersion,
      },
      lowBatteryDrivers: lowBattery.map((d) => ({
        driverId: d._id,
        driverName: d.fullName,
        batteryLevel: d.deviceInfo?.batteryLevel,
        isCharging: d.deviceInfo?.isCharging,
        isOnline: d.isOnline,
      })),
      outdatedAppDrivers: outdatedAppDrivers.map((d) => ({
        driverId: d._id,
        driverName: d.fullName,
        appVersion: d.deviceInfo?.appVersion,
        platform: d.deviceInfo?.platform,
      })),
      versionDistribution,
      platformDistribution,
    };
  } catch (err) {
    console.error("[Driver] Device info summary error:", err);
    res.locals.data = { error: "Failed to fetch device info summary" };
  }
};

/**
 * GET /admin/tracking/demand-zones
 * Get heatmap data for demand zones (order concentration)
 */
export const getDemandZones = async (req: Request, res: Response) => {
  const { hours = 24 } = req.query;
  const startTime = new Date(Date.now() - Number(hours) * 60 * 60 * 1000);

  try {
    // Get order pickup locations for heatmap. Booking pickup stores flat
    // lat/lng (LocationSchema) — the old "pickup.coordinates" GeoJSON path
    // doesn't exist, so the heatmap always came back empty.
    const pickupHeatmap = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: startTime },
          "pickup.lat": { $exists: true },
          "pickup.lng": { $exists: true },
        },
      },
      {
        $project: {
          lat: "$pickup.lat",
          lng: "$pickup.lng",
          status: 1,
        },
      },
      {
        $group: {
          _id: {
            lat: { $round: ["$lat", 3] },
            lng: { $round: ["$lng", 3] },
          },
          count: { $sum: 1 },
          completedCount: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $in: ["$status", ["SEARCHING", "ASSIGNED"]] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          lat: "$_id.lat",
          lng: "$_id.lng",
          intensity: "$count",
          completedCount: 1,
          pendingCount: 1,
        },
      },
    ]);

    // Get high demand zones (clusters with > 5 orders)
    const highDemandZones = pickupHeatmap
      .filter((zone) => zone.intensity >= 5)
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 20);

    // Get active driver locations
    const activeDrivers = await Driver.find({
      isOnline: true,
      "location.lat": { $exists: true },
      "location.lng": { $exists: true },
    })
      .select("location fullName")
      .lean();

    res.locals.data = {
      heatmapData: pickupHeatmap.map((zone) => [zone.lat, zone.lng, zone.intensity]),
      highDemandZones,
      activeDriverLocations: activeDrivers.map((d) => ({
        lat: d.location?.lat,
        lng: d.location?.lng,
        driverName: d.fullName,
      })),
      summary: {
        totalZones: pickupHeatmap.length,
        highDemandZones: highDemandZones.length,
        totalOrders: pickupHeatmap.reduce((sum, z) => sum + z.intensity, 0),
        activeDrivers: activeDrivers.length,
      },
      period: `${hours} hours`,
    };
  } catch (err) {
    console.error("[Tracking] Demand zones error:", err);
    res.locals.data = { error: "Failed to fetch demand zones" };
  }
};
