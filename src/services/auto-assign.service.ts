import { Types } from "mongoose";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import * as bookingDispatchService from "./booking-dispatch.service";
import * as notificationService from "./notification.service";
import { emitBookingUpdate, emitToUser } from "../utils/socket.util";

/**
 * The auto-assign sweep, extracted from the admin controller so the job
 * scheduler can run the SAME code the dashboard button runs — not a parallel
 * implementation that would drift.
 *
 * Assigns the nearest free driver to every SEARCHING booking (or one specific
 * booking), never reusing a driver within a single run.
 */

export interface SweepResult {
  assigned: number;
  evaluated: number;
  results: Array<{
    bookingId: string;
    status: "assigned" | "no_driver" | "no_pickup";
    driverId?: string;
    driverName?: string;
  }>;
}

const assignBookingToDriver = async (booking: any, driver: any) => {
  booking.driverId = driver._id;
  booking.status = "ASSIGNED";
  booking.assignedAt = new Date();
  await booking.save();

  driver.currentBookingId = booking._id;
  await driver.save();

  try {
    const userIdStr = String(booking.userId);
    const driverIdStr = String(driver._id);
    const bookingIdStr = String(booking._id);

    emitBookingUpdate(bookingIdStr, userIdStr, driverIdStr, "ASSIGNED", {
      driverId: driverIdStr,
      driverName: driver.fullName,
      driverPhone: driver.mobileNumber,
      assignedBy: "ADMIN",
    });
    emitToUser(userIdStr, "booking:accepted", {
      bookingId: bookingIdStr,
      driverId: driverIdStr,
      driverName: driver.fullName,
    });
    await notificationService
      .sendToDriver(
        new Types.ObjectId(driverIdStr),
        "BOOKING",
        "New Booking Assigned",
        "You have been auto-assigned a new booking.",
        { bookingId: bookingIdStr },
        booking._id as Types.ObjectId,
        "Booking",
      )
      .catch(() => null);
  } catch (err) {
    console.error("Auto-assign: propagation error", err);
  }
};

export const runAutoAssignSweep = async (
  bookingId?: string,
): Promise<SweepResult> => {
  const query: any = { status: "SEARCHING" };
  if (bookingId) query._id = new Types.ObjectId(bookingId);

  const bookings = await Booking.find(query).sort({ createdAt: 1 }).limit(50);

  let assigned = 0;
  const results: SweepResult["results"] = [];
  // Track drivers assigned within THIS run so we don't double-assign them.
  const usedDrivers = new Set<string>();

  for (const booking of bookings) {
    const lat = booking.pickup?.lat;
    const lng = booking.pickup?.lng;
    if (lat == null || lng == null) {
      results.push({ bookingId: String(booking._id), status: "no_pickup" });
      continue;
    }

    const nearby = await bookingDispatchService.findNearbyDrivers(
      lat,
      lng,
      String(booking.vehicleTypeId || ""),
    );

    // Pick the nearest driver not already used in this run.
    const pick = nearby.find((d) => !usedDrivers.has(d.driverId));
    if (!pick) {
      results.push({ bookingId: String(booking._id), status: "no_driver" });
      continue;
    }

    const driver = await Driver.findById(pick.driverId);
    if (!driver) {
      results.push({ bookingId: String(booking._id), status: "no_driver" });
      continue;
    }

    await assignBookingToDriver(booking, driver);
    usedDrivers.add(pick.driverId);
    assigned += 1;
    results.push({
      bookingId: String(booking._id),
      status: "assigned",
      driverId: String(driver._id),
      driverName: driver.fullName,
    });
  }

  return { assigned, evaluated: bookings.length, results };
};
