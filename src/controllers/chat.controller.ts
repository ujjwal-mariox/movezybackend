import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import ChatMessage from "../models/chat-message.model";
import { uploadFileToAws } from "../utils/s3";
import Booking from "../models/booking.model";
import ChatQuickReply, { seedChatQuickReplies } from "../models/chat-quick-reply.model";

type Caller = { id: string; role: "USER" | "DRIVER" };

const callerOf = (req: Request): Caller | null => {
  const driverId = (req as any).driverId;
  if (driverId) return { id: String(driverId), role: "DRIVER" };
  const userId = (req as any).userId;
  if (userId) return { id: String(userId), role: "USER" };
  return null;
};

/** The caller must be the booking's customer or its driver. */
const isParty = async (bookingId: string, caller: Caller | null): Promise<boolean> => {
  if (!caller || !Types.ObjectId.isValid(bookingId)) return false;
  const b: any = await Booking.findById(bookingId).select("userId driverId").lean();
  if (!b) return false;
  return caller.role === "DRIVER"
    ? String(b.driverId || "") === caller.id
    : String(b.userId || "") === caller.id;
};

/**
 * GET /driver/app/chat/:bookingId/history
 * Fetch chat history for a booking (paginated)
 */
export const getChatHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { bookingId } = req.params;
    if (!(await isParty(bookingId, callerOf(req)))) {
      req.rCode = 0;
      req.msg = "not_booking_party";
      return next();
    }
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const messages = await ChatMessage.find({
      bookingId: new Types.ObjectId(bookingId),
    })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ChatMessage.countDocuments({
      bookingId: new Types.ObjectId(bookingId),
    });

    req.rData = {
      messages,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /driver/app/chat/:bookingId/upload-image
 * Upload a chat image and return its URL
 */
export const uploadChatImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const file = (req as any).files?.[0] || (req as any).file;

    if (!file) {
      req.rCode = 0;
      req.msg = "no_file_uploaded";
      return next();
    }

    const result = await uploadFileToAws([file]);

    req.rData = { imageUrl: result.images };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * GET /chat/:bookingId/unread — messages from the other party not yet read.
 */
export const getUnreadCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bookingId } = req.params;
    const caller = callerOf(req);
    if (!(await isParty(bookingId, caller))) {
      req.rCode = 0;
      req.msg = "not_booking_party";
      return next();
    }
    const count = await ChatMessage.countDocuments({
      bookingId: new Types.ObjectId(bookingId),
      senderId: { $ne: new Types.ObjectId(caller!.id) },
      isRead: false,
    });
    req.rData = { count };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * GET /chat/quick-replies — predefined lines for the caller's side of the
 * conversation (drivers get driver lines, customers get customer lines).
 */
export const getQuickReplies = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const caller = callerOf(req);
    const audience = caller?.role === "DRIVER" ? "DRIVER" : "USER";
    if ((await ChatQuickReply.countDocuments({})) === 0) await seedChatQuickReplies();
    const replies = await ChatQuickReply.find({ audience, isActive: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .select("text sortOrder")
      .lean();
    req.rData = { replies };
    req.msg = "success";
    next();
  } catch (error) {
    next(error);
  }
};
