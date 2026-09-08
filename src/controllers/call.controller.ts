import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import BookingModel from "../models/booking.model";
import DriverModel from "../models/driver.model";
import User from "../models/Users";
import { bridgeCall } from "../services/call-masking.service";

const ACTIVE = ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"];

/**
 * POST /driver/app/bookings/:bookingId/call — driver calls the customer.
 * The customer's number never reaches the app: the server bridges the call
 * (or, when bridging is not configured, hands back the number to dial).
 */
export const driverCallCustomer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const driverId = (req as any).driverId;
    const { bookingId } = req.params;
    if (!Types.ObjectId.isValid(bookingId)) {
      req.rCode = 0;
      req.msg = "booking_not_found";
      return next();
    }
    const booking: any = await BookingModel.findOne({
      _id: bookingId,
      driverId: new Types.ObjectId(driverId),
    })
      .select("bookingNumber status userId pickup")
      .populate("userId", "mobileNumber fullName")
      .lean();
    if (!booking) {
      req.rCode = 0;
      req.msg = "booking_not_found";
      return next();
    }
    if (!ACTIVE.includes(String(booking.status))) {
      req.rCode = 0;
      req.msg = "booking_not_active";
      return next();
    }
    const driver = await DriverModel.findById(driverId).select("mobileNumber").lean();
    const customer = booking.userId || {};
    // The pickup contact, when the customer named one, is the person handing
    // over the goods; otherwise the account holder.
    const targetPhone = booking.pickup?.contactPhone || customer.mobileNumber;

    const result = await bridgeCall({
      bookingId,
      bookingNumber: booking.bookingNumber,
      initiator: { role: "DRIVER", id: driverId, phone: driver?.mobileNumber },
      target: { role: "USER", id: customer._id || booking.userId, phone: targetPhone },
    });
    req.rData = result;
    if (result.mode === "UNAVAILABLE") req.rCode = 0;
    req.msg = result.mode === "UNAVAILABLE" ? "call_unavailable" : "success";
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /bookings/:bookingId/call — customer calls the driver.
 * Plain JSON envelope like the rest of booking.controller.
 */
export const userCallDriver = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { bookingId } = req.params;
    if (!Types.ObjectId.isValid(bookingId)) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const booking: any = await BookingModel.findOne({
      _id: bookingId,
      userId: new Types.ObjectId(String(userId)),
    })
      .select("bookingNumber status driverId")
      .lean();
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (!booking.driverId || !ACTIVE.includes(String(booking.status))) {
      return res.status(400).json({ success: false, message: "No driver is on this booking right now" });
    }
    const [driver, user] = await Promise.all([
      DriverModel.findById(booking.driverId).select("mobileNumber fullName").lean(),
      User.findById(userId).select("mobileNumber").lean(),
    ]);
    const result = await bridgeCall({
      bookingId,
      bookingNumber: booking.bookingNumber,
      initiator: { role: "USER", id: userId, phone: (user as any)?.mobileNumber },
      target: { role: "DRIVER", id: booking.driverId, phone: driver?.mobileNumber },
    });
    if (result.mode === "UNAVAILABLE") {
      return res.status(409).json({ success: false, message: result.message, data: result });
    }
    return res.json({ success: true, message: result.message, data: result });
  } catch (error: any) {
    console.error("userCallDriver failed", error);
    return res.status(500).json({ success: false, message: "Could not place the call" });
  }
};
