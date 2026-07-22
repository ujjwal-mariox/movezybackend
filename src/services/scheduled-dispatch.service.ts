import Booking from "../models/booking.model";
import * as BookingDispatchService from "./booking-dispatch.service";

/**
 * Scheduled-booking dispatcher.
 *
 * A scheduled booking is created with status DRAFT and is NOT dispatched at
 * creation (only immediate bookings are). Nothing promoted it afterwards, so a
 * scheduled booking never rang any driver and never appeared in any pending
 * list — it simply sat in DRAFT until an admin assigned it by hand.
 *
 * This promotes DRAFT → SEARCHING and dispatches once the pickup time is near.
 */

// How far ahead of scheduledAt to start looking for a driver.
const LEAD_TIME_MINUTES = 30;
const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let interval: NodeJS.Timeout | null = null;

export const dispatchDueScheduledBookings = async (): Promise<void> => {
  try {
    const dueBy = new Date(Date.now() + LEAD_TIME_MINUTES * 60 * 1000);

    const due = await Booking.find({
      status: "DRAFT",
      isScheduled: true,
      scheduledAt: { $ne: null, $lte: dueBy },
    })
      .select("_id bookingNumber scheduledAt")
      .limit(50);

    if (due.length === 0) return;

    for (const booking of due) {
      const id = String(booking._id);
      try {
        // Claim it first, conditionally on still being DRAFT, so a concurrent
        // run (or a restart mid-loop) can't dispatch the same booking twice.
        const claimed = await Booking.findOneAndUpdate(
          { _id: booking._id, status: "DRAFT" },
          { status: "SEARCHING" },
          { new: true },
        );
        if (!claimed) continue;

        await BookingDispatchService.dispatchBookingToDrivers(id);
        console.log(
          `[ScheduledDispatch] Dispatched ${booking.bookingNumber || id} (scheduled ${booking.scheduledAt?.toISOString()})`,
        );
      } catch (err: any) {
        // Leave it SEARCHING — it stays discoverable in the driver pending list
        // even if the push/dispatch fan-out failed.
        console.error(
          `[ScheduledDispatch] Failed for ${id}:`,
          err?.message || err,
        );
      }
    }
  } catch (error: any) {
    console.error(
      "[ScheduledDispatch] Error checking scheduled bookings:",
      error?.message || error,
    );
  }
};

export const startScheduledDispatch = () => {
  if (interval) return; // already running

  // Delay the first run so the server (and Mongo/Redis) is warm.
  setTimeout(() => {
    dispatchDueScheduledBookings();
    interval = setInterval(dispatchDueScheduledBookings, INTERVAL_MS);
    console.log(
      `[ScheduledDispatch] Started — dispatching bookings due within ${LEAD_TIME_MINUTES} min, checking every 2 minutes`,
    );
  }, 30_000);
};

export const stopScheduledDispatch = () => {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log("[ScheduledDispatch] Stopped");
  }
};
