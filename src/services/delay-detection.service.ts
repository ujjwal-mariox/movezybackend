/**
 * Delay Detection Service
 *
 * Periodically checks active bookings for ETA deviation.
 * If a driver is significantly behind the estimated arrival/delivery time,
 * it sends a push notification to the user with an updated ETA or delay reason.
 *
 * Runs every 2 minutes via setInterval, started from server.ts
 */

import Booking from "../models/booking.model";
import { sendToUser } from "./notification.service";
import { cache } from "../utils/redis.util";

// Delay thresholds (minutes)
const DELAY_THRESHOLD_MINUTES = 5; // notify when >5 min late (client spec: trigger on ETA deviation > 5 min)
const RE_NOTIFY_COOLDOWN_MINUTES = 15; // don't re-notify within 15 min

/**
 * Check all active bookings for ETA deviations
 */
export const checkDelayedBookings = async () => {
  try {
    const now = new Date();

    // Find all bookings in active delivery states
    const activeBookings = await Booking.find({
      status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
    }).select(
      "_id userId status estimatedArrivalTime estimatedPickupTime estimatedDropTime " +
      "assignedAt driverArrivedAt pickedAt durationMin bookingNumber"
    );

    let notifiedCount = 0;

    for (const booking of activeBookings) {
      try {
        await processBookingDelay(booking, now);
        notifiedCount++;
      } catch (err) {
        // Silently continue for individual booking errors
        console.error(`Delay check failed for booking ${booking._id}:`, err);
      }
    }

    if (activeBookings.length > 0) {
      console.log(
        `[DelayDetection] Checked ${activeBookings.length} active bookings`
      );
    }
  } catch (error) {
    console.error("[DelayDetection] Error checking delayed bookings:", error);
  }
};

/**
 * Process a single booking for delay detection
 */
const processBookingDelay = async (booking: any, now: Date) => {
  const bookingId = booking._id.toString();
  const userId = booking.userId;

  // Check cooldown — don't spam notifications
  const cooldownKey = `delay_notified:${bookingId}`;
  const alreadyNotified = await cache.get(cooldownKey);
  if (alreadyNotified) return;

  let delayMinutes = 0;
  let delayType = "";

  const status = booking.status;

  if (status === "ASSIGNED") {
    // Driver assigned but hasn't arrived
    // Compare current time vs estimated pickup time
    if (booking.estimatedPickupTime) {
      const estimatedPickup = new Date(booking.estimatedPickupTime);
      delayMinutes = Math.floor(
        (now.getTime() - estimatedPickup.getTime()) / (1000 * 60)
      );
      delayType = "pickup";
    } else if (booking.assignedAt && booking.estimatedArrivalTime) {
      // Fallback: assignedAt + estimatedArrivalTime (minutes) = expected arrival
      const assignedAt = new Date(booking.assignedAt);
      const expectedArrival = new Date(
        assignedAt.getTime() + booking.estimatedArrivalTime * 60 * 1000
      );
      delayMinutes = Math.floor(
        (now.getTime() - expectedArrival.getTime()) / (1000 * 60)
      );
      delayType = "driver_arrival";
    }
  } else if (status === "PICKED" || status === "IN_PROGRESS") {
    // Goods picked, en route to drop
    if (booking.estimatedDropTime) {
      const estimatedDrop = new Date(booking.estimatedDropTime);
      delayMinutes = Math.floor(
        (now.getTime() - estimatedDrop.getTime()) / (1000 * 60)
      );
      delayType = "delivery";
    } else if (booking.pickedAt && booking.durationMin) {
      // Fallback: pickedAt + durationMin = expected delivery
      const pickedAt = new Date(booking.pickedAt);
      const expectedDelivery = new Date(
        pickedAt.getTime() + booking.durationMin * 60 * 1000
      );
      delayMinutes = Math.floor(
        (now.getTime() - expectedDelivery.getTime()) / (1000 * 60)
      );
      delayType = "delivery";
    }
  } else if (status === "DRIVER_ARRIVED") {
    // Driver arrived but goods not picked for too long (>15 min)
    if (booking.driverArrivedAt) {
      const arrivedAt = new Date(booking.driverArrivedAt);
      const waitMinutes = Math.floor(
        (now.getTime() - arrivedAt.getTime()) / (1000 * 60)
      );
      if (waitMinutes > 15) {
        delayMinutes = waitMinutes - 15; // waiting beyond 15 min grace
        delayType = "waiting_for_pickup";
      }
    }
  }

  // Only notify if delay exceeds threshold
  if (delayMinutes < DELAY_THRESHOLD_MINUTES) return;

  // Build notification message
  const { title, body } = buildDelayMessage(
    delayType,
    delayMinutes,
    booking.bookingNumber
  );

  // Send notification
  await sendToUser(
    userId,
    "BOOKING",
    title,
    body,
    {
      bookingId,
      status: booking.status,
      delayMinutes: delayMinutes.toString(),
      delayType,
    },
    booking._id,
    "Booking"
  );

  // Set cooldown to prevent re-notification
  await cache.set(cooldownKey, "1", RE_NOTIFY_COOLDOWN_MINUTES * 60);

  console.log(
    `[DelayDetection] Notified user for booking #${booking.bookingNumber} — ${delayType} delay ${delayMinutes}min`
  );
};

/**
 * Build user-friendly delay notification message
 */
const buildDelayMessage = (
  delayType: string,
  delayMinutes: number,
  bookingNumber: string
): { title: string; body: string } => {
  const roundedDelay = Math.ceil(delayMinutes / 5) * 5; // Round up to nearest 5

  switch (delayType) {
    case "driver_arrival":
    case "pickup":
      return {
        title: "Driver Delayed",
        body: `Your driver for #${bookingNumber} is running about ${roundedDelay} min late. We apologize for the delay. Track live on the app.`,
      };

    case "delivery":
      return {
        title: "Delivery Delayed",
        body: `Your delivery #${bookingNumber} is running about ${roundedDelay} min behind schedule. We're working to get it to you ASAP.`,
      };

    case "waiting_for_pickup":
      return {
        title: "Driver Waiting",
        body: `Your driver for #${bookingNumber} has been waiting at pickup for a while. Please hand over the goods to avoid extra charges.`,
      };

    default:
      return {
        title: "Booking Update",
        body: `There's an update on your booking #${bookingNumber}. Please check the app for details.`,
      };
  }
};

/**
 * Start the delay detection interval (call from server.ts)
 * Checks every 2 minutes
 */
let delayCheckInterval: NodeJS.Timeout | null = null;

export const startDelayDetection = () => {
  if (delayCheckInterval) return; // Already running

  const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

  // Run first check after 30 seconds (let server warm up)
  setTimeout(() => {
    checkDelayedBookings();

    // Then run every 2 minutes
    delayCheckInterval = setInterval(checkDelayedBookings, INTERVAL_MS);
    console.log("[DelayDetection] Started — checking every 2 minutes");
  }, 30_000);
};

export const stopDelayDetection = () => {
  if (delayCheckInterval) {
    clearInterval(delayCheckInterval);
    delayCheckInterval = null;
    console.log("[DelayDetection] Stopped");
  }
};
