import { Types } from "mongoose";
import crypto from "crypto";
import Razorpay from "razorpay";
import Booking from "../models/booking.model";
import Wallet from "../models/wallet.model";
import WalletTransaction from "../models/wallet-transaction.model";
import User from "../models/Users";
import config from "../config";

// Razorpay configuration
const RAZORPAY_KEY_ID = config.payment.razorpayKeyId || process.env.RAZORPAY_KEY_ID || "rzp_test_xxxxx";
const RAZORPAY_KEY_SECRET = config.payment.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || "test_secret";

const PLACEHOLDER_KEYS = ["rzp_test_xxxxx", "", "test_secret"];

// True only when a real (non-placeholder) Razorpay key is configured.
const hasRealKeys =
  !!RAZORPAY_KEY_ID &&
  !PLACEHOLDER_KEYS.includes(RAZORPAY_KEY_ID) &&
  !!RAZORPAY_KEY_SECRET &&
  !PLACEHOLDER_KEYS.includes(RAZORPAY_KEY_SECRET);

const isProduction = config.env === "production";

/**
 * Whether mock payment behaviour (fake orders, auto-accept signatures) is
 * permitted. Allowed ONLY in non-production when real keys are absent.
 * In production we must NEVER fake a payment/refund.
 */
export const isMockPaymentAllowed = (): boolean => !isProduction && !hasRealKeys;

/**
 * Throws if a real payment operation is attempted in production without real
 * keys — so we fail loud instead of silently faking success. The server still
 * boots; only the payment/refund call refuses.
 */
const assertPaymentsConfigured = () => {
  if (isProduction && !hasRealKeys) {
    throw new Error(
      "Payment gateway not configured: real Razorpay keys are required in production.",
    );
  }
};

// Razorpay instance
let razorpayInstance: Razorpay | null = null;

interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number | string;
  amount_paid: number | string;
  amount_due: number | string;
  currency: string;
  receipt?: string;
  status: string;
  attempts: number;
  created_at: number;
}

interface PaymentVerificationResult {
  success: boolean;
  message: string;
  paymentId?: string;
  orderId?: string;
}

interface RefundResult {
  success: boolean;
  refundId?: string;
  amount?: number;
  message: string;
}

/**
 * Initialize Razorpay SDK
 */
export const initializeRazorpay = async () => {
  try {
    if (hasRealKeys) {
      razorpayInstance = new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
      });
      console.log("✅ Razorpay SDK initialized with real credentials");
    } else if (isProduction) {
      // Fail loud, but don't crash the whole server — payment calls will refuse.
      console.error(
        "❌ Razorpay keys missing/placeholder in PRODUCTION. Payments & refunds will be REFUSED until configured.",
      );
    } else {
      console.log(
        "⚠️  Razorpay SDK running in mock mode (non-production, no real key configured)",
      );
    }
    return true;
  } catch (error) {
    console.error("Failed to initialize Razorpay:", error);
    return false;
  }
};

/**
 * Create Razorpay order for payment
 */
export const createOrder = async (
  amount: number,
  currency: string = "INR",
  receipt: string,
  notes?: Record<string, string>,
): Promise<RazorpayOrder | null> => {
  try {
    assertPaymentsConfigured();
    const amountInPaise = Math.round(amount * 100); // Convert to paise
    if (razorpayInstance) {
      const order = await razorpayInstance.orders.create({
        amount: amountInPaise,
        currency,
        receipt,
        notes: notes || {},
      });
      return order;
    } else if (isMockPaymentAllowed()) {
      // Mock order for development only (never reached in production)
      const mockOrder: RazorpayOrder = {
        id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        entity: "order",
        amount: amountInPaise,
        amount_paid: 0,
        amount_due: amountInPaise,
        currency,
        receipt,
        status: "created",
        attempts: 0,
        created_at: Date.now(),
      };
      return mockOrder;
    }
    // No gateway instance and mock not allowed → no order.
    return null;
  } catch (error: any) {
    console.error("Failed to create Razorpay order:", error?.message || error);
    return null;
  }
};

/**
 * Verify Razorpay payment signature
 */
export const verifyPaymentSignature = (
  orderId: string,
  paymentId: string,
  signature: string,
): boolean => {
  try {
    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    return expectedSignature === signature;
  } catch (error) {
    console.error("Failed to verify payment signature:", error);
    return false;
  }
};

/**
 * Create order for booking payment
 */
export const createBookingPaymentOrder = async (
  bookingId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<{ order: RazorpayOrder; booking: any } | null> => {
  try {
    const booking = await Booking.findOne({ _id: bookingId, userId });

    if (!booking) {
      throw new Error("Booking not found");
    }

    if (booking.paymentStatus === "PAID") {
      throw new Error("Payment already completed");
    }

    const receiptId = (booking.bookingNumber || bookingId.toString()).slice(-30);
    const order = await createOrder(
      booking.finalFare,
      "INR",
      `bk_${receiptId}`,
      {
        bookingId: bookingId.toString(),
        userId: userId.toString(),
        bookingNumber: booking.bookingNumber || "",
      },
    );

    if (!order) {
      throw new Error("Failed to create payment order");
    }

    // Store order ID in booking
    booking.paymentTransactionId = order.id;
    await booking.save();

    return { order, booking };
  } catch (error) {
    console.error("Failed to create booking payment order:", error);
    return null;
  }
};

/**
 * Verify and complete booking payment
 */
export const verifyBookingPayment = async (
  bookingId: Types.ObjectId,
  orderId: string,
  paymentId: string,
  signature: string,
): Promise<PaymentVerificationResult> => {
  try {
    assertPaymentsConfigured();
    // Real keys: always verify the signature. Mock mode (non-prod only):
    // accept without a real signature so local dev flows work.
    const isValid = razorpayInstance
      ? verifyPaymentSignature(orderId, paymentId, signature)
      : isMockPaymentAllowed();

    if (!isValid) {
      return {
        success: false,
        message: "Invalid payment signature",
      };
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return {
        success: false,
        message: "Booking not found",
      };
    }

    if (booking.paymentStatus === "PAID") {
      // Idempotent: a retried verify shouldn't error or re-stamp.
      return {
        success: true,
        message: "Payment already verified",
        paymentId,
        orderId,
      };
    }

    // A valid signature only proves "this payment belongs to this order" — NOT
    // that the order belongs to THIS booking, nor that the right amount was
    // paid. Without these checks a cheap paid order's (orderId,paymentId,
    // signature) could be replayed against an expensive booking to mark it PAID.
    if (razorpayInstance) {
      // createBookingPaymentOrder stored the order id here.
      if (booking.paymentTransactionId !== orderId) {
        return {
          success: false,
          message: "This payment does not belong to this booking",
        };
      }

      const order = await razorpayInstance.orders.fetch(orderId);
      if (!order) {
        return { success: false, message: "Payment order not found" };
      }
      // Cross-check the order's own record of which booking it was for.
      const orderBookingId = (order.notes as any)?.bookingId;
      if (orderBookingId && String(orderBookingId) !== String(bookingId)) {
        return {
          success: false,
          message: "This payment does not belong to this booking",
        };
      }
      // Amount must match the fare (paise). Guard against a stale order created
      // before the fare changed (e.g. waiting charges added at pickup).
      const expectedPaise = Math.round(booking.finalFare * 100);
      if (Number(order.amount) !== expectedPaise) {
        return {
          success: false,
          message: "Paid amount does not match the booking fare",
        };
      }
      if (order.status === "created") {
        return { success: false, message: "Payment not captured for this order" };
      }
    }

    booking.paymentStatus = "PAID";
    booking.paymentTransactionId = paymentId;
    (booking as any).paidAt = new Date();
    await booking.save();

    return {
      success: true,
      message: "Payment verified successfully",
      paymentId,
      orderId,
    };
  } catch (error: any) {
    console.error("Failed to verify booking payment:", error);
    return {
      success: false,
      message: error.message || "Payment verification failed",
    };
  }
};

/**
 * Process refund for booking
 */
export const processRefund = async (
  bookingId: Types.ObjectId,
  amount?: number,
  reason?: string,
): Promise<RefundResult> => {
  try {
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return { success: false, message: "Booking not found" };
    }

    if (booking.paymentStatus !== "PAID") {
      return { success: false, message: "No payment to refund" };
    }

    assertPaymentsConfigured();
    const refundAmount = amount || booking.finalFare;

    if (razorpayInstance && booking.paymentTransactionId) {
      const refund = await razorpayInstance.payments.refund(
        booking.paymentTransactionId,
        {
          amount: Math.round(refundAmount * 100), // Convert to paise
          notes: {
            bookingId: bookingId.toString(),
            reason: reason || "Booking cancelled",
          },
        },
      );

      booking.refundAmount = refundAmount;
      booking.refundStatus = "PROCESSED";
      await booking.save();

      return {
        success: true,
        refundId: refund.id,
        amount: refundAmount,
        message: "Refund processed successfully",
      };
    } else if (isMockPaymentAllowed()) {
      // Mock refund — non-production only. Never fakes a refund in production.
      booking.refundAmount = refundAmount;
      booking.refundStatus = "PROCESSED";
      await booking.save();

      return {
        success: true,
        refundId: `refund_${Date.now()}`,
        amount: refundAmount,
        message: "Refund processed successfully (mock)",
      };
    }

    // Real keys configured but no gateway transaction id to refund against,
    // and mock is not allowed — refuse rather than fake success.
    return {
      success: false,
      message: "No gateway transaction available to refund",
    };
  } catch (error: any) {
    console.error("Failed to process refund:", error);
    return {
      success: false,
      message: error.message || "Refund processing failed",
    };
  }
};

/**
 * Add money to wallet
 */
export const createWalletRechargeOrder = async (
  userId: Types.ObjectId,
  amount: number,
): Promise<RazorpayOrder | null> => {
  // Receipt must be ≤ 40 chars (Razorpay limit)
  const shortId = userId.toString().slice(-8);
  const receipt = `wr_${shortId}_${Date.now()}`;
  const order = await createOrder(
    amount,
    "INR",
    receipt,
    {
      userId: userId.toString(),
      type: "wallet_recharge",
    },
  );

  return order;
};

/**
 * Verify and complete wallet recharge
 */
export const verifyWalletRecharge = async (
  userId: Types.ObjectId,
  orderId: string,
  paymentId: string,
  signature: string,
  amount: number,
): Promise<PaymentVerificationResult> => {
  try {
    assertPaymentsConfigured();
    const isValid = razorpayInstance
      ? verifyPaymentSignature(orderId, paymentId, signature)
      : isMockPaymentAllowed();

    if (!isValid) {
      return {
        success: false,
        message: "Invalid payment signature",
      };
    }

    // Credit the amount RAZORPAY actually captured, never the client's `amount`.
    // The signature only binds orderId+paymentId, not the amount, so trusting
    // req.body.amount let a ₹10 payment credit any sum. The order was created
    // server-side, so its amount is authoritative (paise → rupees).
    let creditAmount = amount;
    if (razorpayInstance) {
      const order = await razorpayInstance.orders.fetch(orderId);
      if (!order || order.status === "created") {
        // "created" = no successful payment captured against this order.
        return {
          success: false,
          message: "Payment not captured for this order",
        };
      }
      creditAmount = Number(order.amount) / 100;
    }

    // Find or create wallet
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0,
      });
    }

    const balanceBefore = wallet.balance;
    wallet.balance += creditAmount;
    await wallet.save();

    // Create transaction record
    await WalletTransaction.create({
      userId,
      type: "CREDIT",
      amount: creditAmount,
      balanceBefore,
      balanceAfter: wallet.balance,
      description: "Wallet recharge",
      referenceId: paymentId,
      status: "COMPLETED",
    });

    return {
      success: true,
      message: "Wallet recharged successfully",
      paymentId,
      orderId,
    };
  } catch (error: any) {
    console.error("Failed to verify wallet recharge:", error);
    return {
      success: false,
      message: error.message || "Wallet recharge failed",
    };
  }
};

/**
 * Pay using wallet balance
 */
export const payUsingWallet = async (
  userId: Types.ObjectId,
  bookingId: Types.ObjectId,
): Promise<{ success: boolean; message: string }> => {
  try {
    const [wallet, booking] = await Promise.all([
      Wallet.findOne({ userId }),
      Booking.findOne({ _id: bookingId, userId }),
    ]);

    if (!booking) {
      return { success: false, message: "Booking not found" };
    }

    if (booking.paymentStatus === "PAID") {
      return { success: false, message: "Already paid" };
    }

    if (!wallet || wallet.balance < booking.finalFare) {
      return { success: false, message: "Insufficient wallet balance" };
    }

    // Deduct from wallet
    wallet.balance -= booking.finalFare;
    await wallet.save();

    // Create transaction
    await WalletTransaction.create({
      userId,
      type: "DEBIT",
      amount: booking.finalFare,
      balanceBefore: wallet.balance + booking.finalFare,
      balanceAfter: wallet.balance,
      description: `Payment for booking ${booking.bookingNumber || "N/A"}`,
      referenceId: bookingId.toString(),
      status: "COMPLETED",
    });

    // Update booking
    booking.paymentStatus = "PAID";
    booking.paymentMethod = "WALLET";
    await booking.save();

    return { success: true, message: "Payment successful" };
  } catch (error: any) {
    console.error("Failed to pay using wallet:", error);
    return { success: false, message: error.message || "Payment failed" };
  }
};

/**
 * Get payment methods for user
 */
export const getPaymentMethods = async (userId: Types.ObjectId) => {
  const wallet = await Wallet.findOne({ userId });

  return {
    wallet: {
      available: true,
      balance: wallet?.balance || 0,
    },
    upi: {
      available: true,
      providers: ["GOOGLE_PAY", "PHONEPE", "PAYTM"],
    },
    cards: {
      available: true,
    },
    netBanking: {
      available: true,
    },
    cash: {
      available: true,
    },
  };
};

/**
 * Handle Razorpay webhook
 */
export const handleWebhook = async (
  payload: any,
  signature: string,
): Promise<{ success: boolean; message: string }> => {
  try {
    // Verify webhook signature.
    // Source of truth is config.payment.webhookSecret (PAYMENT_WEBHOOK_SECRET);
    // fall back to the legacy RAZORPAY_WEBHOOK_SECRET env name for compatibility.
    const webhookSecret =
      config.payment.webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || "";

    // Fail closed: never accept a webhook when no secret is configured.
    if (!webhookSecret) {
      console.error("Webhook secret not configured; rejecting webhook.");
      return { success: false, message: "Webhook secret not configured" };
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(JSON.stringify(payload))
      .digest("hex");

    if (signature !== expectedSignature) {
      return { success: false, message: "Invalid webhook signature" };
    }

    const event = payload.event;
    const paymentEntity = payload.payload?.payment?.entity;
    const refundEntity = payload.payload?.refund?.entity;

    // Bookings store the Razorpay order id in paymentTransactionId
    // (set in createBookingPaymentOrder), so we reconcile by order_id.
    switch (event) {
      case "payment.captured": {
        const orderId = paymentEntity?.order_id;
        if (orderId) {
          const updated = await Booking.findOneAndUpdate(
            { paymentTransactionId: orderId, paymentStatus: { $ne: "PAID" } },
            {
              paymentStatus: "PAID",
              paymentTransactionId: paymentEntity.id,
              paidAt: new Date(),
            },
            { new: true },
          );
          console.log(
            `Webhook payment.captured ${paymentEntity?.id} → booking ${updated?._id || "not found"}`,
          );
        }
        break;
      }

      case "payment.failed": {
        const orderId = paymentEntity?.order_id;
        if (orderId) {
          await Booking.findOneAndUpdate(
            { paymentTransactionId: orderId, paymentStatus: { $ne: "PAID" } },
            { paymentStatus: "FAILED" },
          );
        }
        console.log("Webhook payment.failed:", paymentEntity?.id);
        break;
      }

      case "refund.processed": {
        // Match by the original payment id stored on the booking.
        const paymentId = refundEntity?.payment_id;
        if (paymentId) {
          await Booking.findOneAndUpdate(
            { paymentTransactionId: paymentId },
            {
              refundStatus: "PROCESSED",
              refundAmount: refundEntity?.amount
                ? Number(refundEntity.amount) / 100
                : undefined,
            },
          );
        }
        console.log("Webhook refund.processed:", refundEntity?.id);
        break;
      }

      default:
        console.log("Unhandled webhook event:", event);
    }

    return { success: true, message: "Webhook processed" };
  } catch (error: any) {
    console.error("Failed to handle webhook:", error);
    return { success: false, message: error.message };
  }
};

/**
 * Get transaction history
 */
export const getTransactionHistory = async (
  userId: Types.ObjectId,
  page: number = 1,
  limit: number = 20,
) => {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    WalletTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    WalletTransaction.countDocuments({ userId }),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};
