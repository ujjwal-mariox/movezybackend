import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import ChatMessage from "../models/chat-message.model";
import { uploadFileToAws } from "../utils/s3";

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
