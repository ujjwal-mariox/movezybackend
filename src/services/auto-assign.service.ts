import { Types } from "mongoose";
import Booking from "../models/booking.model";
import * as bookingDispatchService from "./booking-dispatch.service";

/** Admin and scheduled sweeps offer jobs through the normal dispatch queue.
 * A booking remains SEARCHING until the current offered driver accepts it. */
export interface SweepResult {
  assigned: number; // Older admin clients: an offer is never an assignment.
  offered: number;
  awaitingResponse: number;
  evaluated: number;
  results: Array<{
    bookingId: string;
    status: "offered" | "awaiting_response" | "no_driver" | "no_pickup";
    driverId?: string;
  }>;
}

export const runAutoAssignSweep = async (bookingId?: string): Promise<SweepResult> => {
  const query: any = { status: "SEARCHING", driverId: null };
  if (bookingId) query._id = new Types.ObjectId(bookingId);
  const bookings = await Booking.find(query).sort({ createdAt: 1 }).limit(50);
  let offered = 0;
  let awaitingResponse = 0;
  const results: SweepResult["results"] = [];
  for (const booking of bookings) {
    const bid = String(booking._id);
    if (booking.pickup?.lat == null || booking.pickup?.lng == null) {
      results.push({ bookingId: bid, status: "no_pickup" });
      continue;
    }
    const newOffers = await bookingDispatchService.offerNext(bid);
    if (newOffers.length) {
      offered++;
      results.push({ bookingId: bid, status: "offered", driverId: newOffers[0] });
      continue;
    }
    const current = await bookingDispatchService.getBookingOfferDriverIds(bid);
    if (current.length) {
      awaitingResponse++;
      results.push({ bookingId: bid, status: "awaiting_response", driverId: current[0] });
    } else {
      results.push({ bookingId: bid, status: "no_driver" });
    }
  }
  return { assigned: 0, offered, awaitingResponse, evaluated: bookings.length, results };
};
