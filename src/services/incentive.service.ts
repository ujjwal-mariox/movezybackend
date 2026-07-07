/**
 * Driver incentive computation.
 *
 * There is no separate "incentive" collection — incentives are derived in real
 * time from the driver's actual COMPLETED bookings against configurable targets.
 * This keeps progress honest (it always matches real trips/earnings) without a
 * standalone rules engine. Targets can be tuned via env; defaults below.
 */
import { Types } from "mongoose";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Tunable targets/rewards (env-overridable).
const DAILY_TARGET = num(process.env.INCENTIVE_DAILY_TARGET, 10);
const DAILY_REWARD = num(process.env.INCENTIVE_DAILY_REWARD, 300);
const WEEKLY_TARGET = num(process.env.INCENTIVE_WEEKLY_TARGET, 30);
const WEEKLY_REWARD = num(process.env.INCENTIVE_WEEKLY_REWARD, 500);
const PEAK_TARGET = num(process.env.INCENTIVE_PEAK_TARGET, 5);
const PEAK_REWARD = num(process.env.INCENTIVE_PEAK_REWARD, 150);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const startOfWeek = () => {
  const d = startOfToday();
  // Monday as the first day of the week.
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
};

// Peak windows: 06:00–10:00 and 17:00–21:00 local time.
const isPeakHour = (date: Date) => {
  const h = date.getHours();
  return (h >= 6 && h < 10) || (h >= 17 && h < 21);
};

interface Tracker {
  key: string;
  title: string;
  current: number;
  target: number;
  reward: number;
  achieved: boolean;
  remaining: number;
}

const makeTracker = (
  key: string,
  title: string,
  current: number,
  target: number,
  reward: number,
): Tracker => {
  const achieved = current >= target;
  return {
    key,
    title,
    current,
    target,
    reward,
    achieved,
    remaining: Math.max(target - current, 0),
  };
};

/**
 * Compute the full incentive summary for a driver from real booking data.
 */
export const getDriverIncentiveSummary = async (driverIdStr: string) => {
  const driverId = new Types.ObjectId(driverIdStr);
  const todayStart = startOfToday();
  const weekStart = startOfWeek();

  const [todayCompleted, weekCompleted, driver] = await Promise.all([
    Booking.find({
      driverId,
      status: "COMPLETED",
      completedAt: { $gte: todayStart },
    })
      .select("finalFare fare completedAt")
      .lean(),
    Booking.countDocuments({
      driverId,
      status: "COMPLETED",
      completedAt: { $gte: weekStart },
    }),
    Driver.findById(driverId).select("rating").lean(),
  ]);

  const todayTrips = todayCompleted.length;
  const todayEarnings = todayCompleted.reduce(
    (sum, b: any) => sum + (b.finalFare ?? b.fare ?? 0),
    0,
  );
  const peakTripsToday = todayCompleted.filter((b: any) =>
    b.completedAt ? isPeakHour(new Date(b.completedAt)) : false,
  ).length;

  const trackers = [
    makeTracker("daily", "Daily Target", todayTrips, DAILY_TARGET, DAILY_REWARD),
    makeTracker("weekly", "Weekly Milestone", weekCompleted, WEEKLY_TARGET, WEEKLY_REWARD),
    makeTracker("peak", "Peak Hour Bonus", peakTripsToday, PEAK_TARGET, PEAK_REWARD),
  ];

  // Earned incentives = rewards of achieved trackers.
  const incentivesEarned = trackers
    .filter((t) => t.achieved)
    .reduce((sum, t) => sum + t.reward, 0);

  return {
    todayEarnings: Math.round(todayEarnings),
    todayTrips,
    weekTrips: weekCompleted,
    peakTripsToday,
    rating: (driver as any)?.rating ?? 0,
    incentivesEarned,
    trackers,
  };
};

/**
 * Active incentive offers = the trackers not yet achieved (what the driver can
 * still earn). Shape kept compatible with the old getActiveIncentives payload
 * (_id/title/reward/progress/target) so existing clients don't break.
 */
export const getActiveIncentiveOffers = async (driverIdStr: string) => {
  const summary = await getDriverIncentiveSummary(driverIdStr);
  return summary.trackers
    .filter((t) => !t.achieved)
    .map((t) => ({
      _id: t.key,
      title:
        t.remaining > 0
          ? `${t.remaining} more ${t.remaining === 1 ? "trip" : "trips"} to earn ₹${t.reward}`
          : t.title,
      reward: t.reward,
      progress: t.current,
      target: t.target,
    }));
};
