import { Request, Response } from "express";
import mongoose from "mongoose";
import { RefundRequest } from "../../models/refund-request.model";
import Booking from "../../models/booking.model";
import { Expense } from "../../models/expense.model";
import { AppConfig } from "../../models/app-config.model";
import * as PaymentService from "../../services/payment.service";

/**
 * Get refund configuration (thresholds, etc.)
 */
export const getRefundConfig = async (req: Request, res: Response) => {
  const config = await AppConfig.findOne({ key: "refund" });
  
  res.locals.data = {
    config: config?.value || {
      autoApproveL2Threshold: 500,
      maxRefundDays: 30,
      requireL2Above: 1000,
    },
  };
};

/**
 * Update refund configuration
 */
export const updateRefundConfig = async (req: Request, res: Response) => {
  const { autoApproveL2Threshold, maxRefundDays, requireL2Above } = req.body;

  const config = await AppConfig.findOneAndUpdate(
    { key: "refund" },
    {
      $set: {
        value: {
          autoApproveL2Threshold: autoApproveL2Threshold || 500,
          maxRefundDays: maxRefundDays || 30,
          requireL2Above: requireL2Above || 1000,
        },
        updatedBy: req.adminId,
      },
    },
    { upsert: true, new: true },
  );

  res.locals.data = { config: config.value, message: "Refund configuration updated" };
};

/**
 * Request a new refund (creates pending request)
 */
export const requestRefund = async (req: Request, res: Response) => {
  const { bookingId, amount, reason } = req.body;

  // Validate booking
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking not found" });
  }

  if (booking.refundStatus === "PROCESSED") {
    return res.status(400).json({ success: false, message: "Refund already processed for this booking" });
  }

  // Check if there's already a pending refund request
  const existingRequest = await RefundRequest.findOne({
    bookingId,
    status: { $in: ["PENDING_L1", "PENDING_L2"] },
  });

  if (existingRequest) {
    return res.status(400).json({
      success: false,
      message: "A refund request is already pending for this booking",
    });
  }

  // Get refund config
  const config = await AppConfig.findOne({ key: "refund" });
  const autoApproveThreshold = config?.value?.autoApproveL2Threshold || 500;

  // Create refund request
  const refundRequest = await RefundRequest.create({
    bookingId,
    amount,
    reason,
    requestedBy: req.adminId,
    status: "PENDING_L1",
    autoApproveThreshold,
  });

  // Update booking refund status
  booking.refundStatus = "PENDING";
  booking.refundAmount = amount;
  await booking.save();

  res.locals.data = {
    message: "Refund request created successfully",
    refundRequest,
  };
};

/**
 * Get all refund requests with filters
 */
export const getAllRefundRequests = async (req: Request, res: Response) => {
  const { status, dateFrom, dateTo, page = 0, limit = 20 } = req.query;

  const query: any = {};

  if (status) query.status = status;

  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) query.createdAt.$lte = new Date(dateTo as string);
  }

  const requests = await RefundRequest.find(query)
    .populate("bookingId", "bookingNumber finalFare userId paymentMethod")
    .populate("requestedBy", "fullName email")
    .populate("level1ApprovedBy", "fullName email")
    .populate("level2ApprovedBy", "fullName email")
    .populate("rejectedBy", "fullName email")
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await RefundRequest.countDocuments(query);

  // Get stats
  const stats = await RefundRequest.aggregate([
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        totalAmount: { $sum: "$amount" },
      },
    },
  ]);

  res.locals.data = {
    requests,
    stats,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

/**
 * Get single refund request by ID
 */
export const getRefundRequestById = async (req: Request, res: Response) => {
  const { id } = req.params;

  const request = await RefundRequest.findById(id)
    .populate({
      path: "bookingId",
      populate: [
        { path: "userId", select: "fullName mobileNumber email" },
        { path: "driverId", select: "fullName mobileNumber" },
      ],
    })
    .populate("requestedBy", "fullName email")
    .populate("level1ApprovedBy", "fullName email")
    .populate("level2ApprovedBy", "fullName email")
    .populate("rejectedBy", "fullName email")
    .populate("processedBy", "fullName email");

  if (!request) {
    return res.status(404).json({ success: false, message: "Refund request not found" });
  }

  res.locals.data = { request };
};

/**
 * Approve refund - Level 1
 */
export const approveRefundL1 = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { comment } = req.body;

  const request = await RefundRequest.findById(id);

  if (!request) {
    return res.status(404).json({ success: false, message: "Refund request not found" });
  }

  if (request.status !== "PENDING_L1") {
    return res.status(400).json({
      success: false,
      message: `Cannot approve L1: current status is ${request.status}`,
    });
  }

  // Same admin cannot approve their own request
  if (request.requestedBy.toString() === req.adminId) {
    return res.status(400).json({
      success: false,
      message: "You cannot approve your own refund request",
    });
  }

  request.level1ApprovedBy = new mongoose.Types.ObjectId(req.adminId);
  request.level1ApprovedAt = new Date();
  request.level1Comment = comment;

  // Check if amount is below auto-approve threshold - skip L2
  if (request.amount <= (request.autoApproveThreshold || 500)) {
    request.status = "APPROVED";
    request.level2ApprovedBy = new mongoose.Types.ObjectId(req.adminId);
    request.level2ApprovedAt = new Date();
    request.level2Comment = "Auto-approved: amount below threshold";
  } else {
    request.status = "PENDING_L2";
  }

  await request.save();

  res.locals.data = {
    message: request.status === "APPROVED" 
      ? "Refund auto-approved (below threshold)" 
      : "Refund approved for Level 2 review",
    request,
  };
};

/**
 * Approve refund - Level 2
 */
export const approveRefundL2 = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { comment } = req.body;

  const request = await RefundRequest.findById(id);

  if (!request) {
    return res.status(404).json({ success: false, message: "Refund request not found" });
  }

  if (request.status !== "PENDING_L2") {
    return res.status(400).json({
      success: false,
      message: `Cannot approve L2: current status is ${request.status}`,
    });
  }

  // L1 approver cannot also approve L2
  if (request.level1ApprovedBy?.toString() === req.adminId) {
    return res.status(400).json({
      success: false,
      message: "L1 approver cannot also approve L2",
    });
  }

  request.level2ApprovedBy = new mongoose.Types.ObjectId(req.adminId);
  request.level2ApprovedAt = new Date();
  request.level2Comment = comment;
  request.status = "APPROVED";

  await request.save();

  res.locals.data = {
    message: "Refund approved (Level 2)",
    request,
  };
};

/**
 * Reject refund request
 */
export const rejectRefund = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;

  const request = await RefundRequest.findById(id);

  if (!request) {
    return res.status(404).json({ success: false, message: "Refund request not found" });
  }

  if (!["PENDING_L1", "PENDING_L2"].includes(request.status)) {
    return res.status(400).json({
      success: false,
      message: `Cannot reject: current status is ${request.status}`,
    });
  }

  request.status = "REJECTED";
  request.rejectedBy = new mongoose.Types.ObjectId(req.adminId);
  request.rejectedAt = new Date();
  request.rejectionReason = reason;

  await request.save();

  // Update booking refund status
  await Booking.findByIdAndUpdate(request.bookingId, {
    refundStatus: "FAILED",
  });

  res.locals.data = {
    message: "Refund request rejected",
    request,
  };
};

/**
 * Process approved refund (actual payment)
 */
export const processRefund = async (req: Request, res: Response) => {
  const { id } = req.params;

  const request = await RefundRequest.findById(id).populate("bookingId");

  if (!request) {
    return res.status(404).json({ success: false, message: "Refund request not found" });
  }

  if (request.status !== "APPROVED") {
    return res.status(400).json({
      success: false,
      message: `Cannot process: refund is not approved (status: ${request.status})`,
    });
  }

  // Process the refund through the real payment gateway. processRefund updates
  // the booking's refundStatus/refundAmount and returns the gateway refund id
  // (or a mock id in non-production). It refuses (no fake success) in production
  // when keys are missing.
  const bookingId = (request.bookingId as any)?._id || request.bookingId;
  const gatewayResult = await PaymentService.processRefund(
    bookingId,
    request.amount,
    request.reason || "Admin-approved refund",
  );

  if (!gatewayResult.success) {
    return res.status(502).json({
      success: false,
      message: `Gateway refund failed: ${gatewayResult.message}`,
    });
  }

  const transactionId = gatewayResult.refundId || `REF_${Date.now()}`;

  request.status = "PROCESSED";
  request.processedAt = new Date();
  request.transactionId = transactionId;
  request.processedBy = new mongoose.Types.ObjectId(req.adminId);

  await request.save();

  // processRefund already set booking.refundStatus/refundAmount; this keeps the
  // booking consistent even if the amount was clamped.
  await Booking.findByIdAndUpdate(bookingId, {
    refundStatus: "PROCESSED",
    refundAmount: request.amount,
  });

  // Create expense record
  await Expense.create({
    category: "REFUND",
    amount: request.amount,
    description: `Refund for booking ${(request.bookingId as any).bookingNumber || request.bookingId}`,
    date: new Date(),
    bookingId: request.bookingId,
    refundRequestId: request._id,
    transactionId,
    status: "PAID",
    createdBy: req.adminId,
  });

  res.locals.data = {
    message: "Refund processed successfully",
    transactionId,
    request,
  };
};

/**
 * Get refund stats for dashboard
 */
export const getRefundStats = async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;

  const matchStage: any = {};
  if (dateFrom || dateTo) {
    matchStage.createdAt = {};
    if (dateFrom) matchStage.createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) matchStage.createdAt.$lte = new Date(dateTo as string);
  }

  const [statusStats, dailyStats, averageProcessingTime] = await Promise.all([
    RefundRequest.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),

    RefundRequest.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
          processed: {
            $sum: { $cond: [{ $eq: ["$status", "PROCESSED"] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 30 },
    ]),

    RefundRequest.aggregate([
      { $match: { ...matchStage, status: "PROCESSED" } },
      {
        $project: {
          processingDays: {
            $divide: [
              { $subtract: ["$processedAt", "$createdAt"] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgDays: { $avg: "$processingDays" },
        },
      },
    ]),
  ]);

  res.locals.data = {
    statusStats,
    dailyStats,
    averageProcessingDays: averageProcessingTime[0]?.avgDays?.toFixed(2) || 0,
  };
};
