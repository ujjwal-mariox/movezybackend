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
import DriverIncentive from "../models/driver-incentive.model";

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

/** "2026-07-17" — the window a daily/peak bonus belongs to. */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/** "2026-W29" — the window a weekly bonus belongs to (Monday-based). */
const weekKey = (d: Date) => {
  const monday = startOfWeek();
  const jan1 = new Date(monday.getFullYear(), 0, 1);
  const week = Math.floor(
    (monday.getTime() - jan1.getTime()) / (7 * 24 * 60 * 60 * 1000),
  ) + 1;
  return `${monday.getFullYear()}-W${String(week).padStart(2, "0")}`;
};

/**
 * Persist any bonus the driver has now earned.
 *
 * Called after each completed trip. Relies on the unique
 * (driverId, type, periodKey) index for idempotency rather than a
 * read-then-write check — two trips completing at once would both pass a
 * "has it been awarded?" read and pay the bonus twice.
 */
export const awardEarnedIncentives = async (driverIdStr: string) => {
  const driverId = new Types.ObjectId(driverIdStr);
  const now = new Date();
  const todayStart = startOfToday();
  const weekStart = startOfWeek();

  const [todayCompleted, weekCompleted] = await Promise.all([
    Booking.find({
      driverId,
      status: "COMPLETED",
      completedAt: { $gte: todayStart },
    })
      .select("completedAt")
      .lean(),
    Booking.countDocuments({
      driverId,
      status: "COMPLETED",
      completedAt: { $gte: weekStart },
    }),
  ]);

  const peakTripsToday = todayCompleted.filter((b: any) =>
    b.completedAt ? isPeakHour(new Date(b.completedAt)) : false,
  ).length;

  const candidates = [
    {
      type: "daily" as const,
      title: "Daily Target",
      current: todayCompleted.length,
      target: DAILY_TARGET,
      amount: DAILY_REWARD,
      periodKey: dayKey(now),
    },
    {
      type: "weekly" as const,
      title: "Weekly Milestone",
      current: weekCompleted,
      target: WEEKLY_TARGET,
      amount: WEEKLY_REWARD,
      periodKey: weekKey(now),
    },
    {
      type: "peak" as const,
      title: "Peak Hour Bonus",
      current: peakTripsToday,
      target: PEAK_TARGET,
      amount: PEAK_REWARD,
      periodKey: dayKey(now),
    },
  ].filter((c) => c.current >= c.target);

  for (const c of candidates) {
    try {
      await DriverIncentive.updateOne(
        { driverId, type: c.type, periodKey: c.periodKey },
        {
          $setOnInsert: {
            driverId,
            type: c.type,
            periodKey: c.periodKey,
            title: c.title,
            amount: c.amount,
            progressAtAward: c.current,
            target: c.target,
            awardedAt: now,
          },
        },
        { upsert: true },
      );
    } catch (e: any) {
      // Duplicate key = another concurrent trip already awarded this window.
      // That is the index doing its job, not a failure.
      if (e?.code !== 11000) throw e;
    }
  }
};

/** Bonuses actually awarded to this driver, newest first. */
export const getDriverIncentiveHistory = async (driverIdStr: string) => {
  return DriverIncentive.find({ driverId: new Types.ObjectId(driverIdStr) })
    .sort({ awardedAt: -1 })
    .lean();
};

/** Total bonus money this driver is owed. Included in their payout balance. */
export const getAwardedIncentiveTotal = async (driverId: Types.ObjectId) => {
  const agg = await DriverIncentive.aggregate([
    { $match: { driverId } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return agg[0]?.total ?? 0;
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
      .select("driverEarnings finalFare fare completedAt")
      .lean(),
    Booking.countDocuments({
      driverId,
      status: "COMPLETED",
      completedAt: { $gte: weekStart },
    }),
    Driver.findById(driverId).select("rating").lean(),
  ]);

  const todayTrips = todayCompleted.length;
  // What the driver actually earned, not what the customer paid. Summing
  // finalFare here showed the gross — GST and commission included — which is
  // ~24% more than the driver can ever withdraw, so the dashboard headline
  // would contradict the payout balance on the very next screen.
  const todayEarnings = todayCompleted.reduce(
    (sum, b: any) => sum + (b.driverEarnings ?? 0),
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

  // Report what has actually been awarded and is owed, not a live sum of
  // whichever trackers happen to read as achieved right now. The app puts this
  // under "Total (Earnings + Bonus)" next to a wallet icon, so it has to be
  // money the driver can really collect.
  const incentivesEarned = await getAwardedIncentiveTotal(driverId);

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
