/**
 * Scheduled reports engine.
 *
 * Stores report schedules (ScheduledReport) and, on an interval, generates the
 * due ones from REAL data and emails them via the gated email service. When
 * SMTP is unconfigured the email is logged (not faked) — the schedule still
 * runs and records lastStatus="LOGGED" so it's honest.
 */
import ScheduledReport, {
  IScheduledReport,
  ReportFrequency,
  ReportTemplate,
} from "../models/scheduled-report.model";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import User from "../models/Users";
import { sendEmail, isEmailConfigured } from "./email.service";

/**
 * Compute the next run time from a base date, given frequency + day/hour.
 */
export const computeNextRun = (
  from: Date,
  frequency: ReportFrequency,
  opts: { dayOfWeek?: number; dayOfMonth?: number; hour: number },
): Date => {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(opts.hour, 0, 0, 0);

  if (frequency === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (frequency === "weekly") {
    const targetDow = opts.dayOfWeek ?? 0; // Mon=0
    // JS getDay(): Sun=0..Sat=6 → convert to Mon=0..Sun=6
    const currentDow = (next.getDay() + 6) % 7;
    let delta = targetDow - currentDow;
    if (delta < 0 || (delta === 0 && next <= from)) delta += 7;
    next.setDate(next.getDate() + delta);
    return next;
  }

  // monthly
  const targetDom = opts.dayOfMonth ?? 1;
  next.setDate(targetDom);
  if (next <= from) {
    next.setMonth(next.getMonth() + 1);
    next.setDate(targetDom);
  }
  return next;
};

const startOfRange = (frequency: ReportFrequency): Date => {
  const now = new Date();
  const d = new Date(now);
  if (frequency === "daily") d.setDate(d.getDate() - 1);
  else if (frequency === "weekly") d.setDate(d.getDate() - 7);
  else d.setMonth(d.getMonth() - 1);
  return d;
};

const inr = (n: number) => `₹${Math.round(n || 0).toLocaleString("en-IN")}`;

/**
 * Build the real report body for a template over the schedule's window.
 * Returns plain text (also usable as the email text/html).
 */
export const generateReportContent = async (
  template: ReportTemplate,
  frequency: ReportFrequency,
): Promise<{ subject: string; body: string }> => {
  const since = startOfRange(frequency);
  const now = new Date();
  const window = `${since.toISOString().slice(0, 10)} → ${now
    .toISOString()
    .slice(0, 10)}`;
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`Movezy — ${template} (${frequency})`);
  push(`Window: ${window}`);
  push(`Generated: ${now.toISOString()}`);
  push("");

  if (template === "weekly_fin") {
    const agg = await Booking.aggregate([
      { $match: { status: "COMPLETED", createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$finalFare" },
          gst: { $sum: "$gstAmount" },
          discount: { $sum: "$totalDiscount" },
          count: { $sum: 1 },
        },
      },
    ]);
    const r = agg[0] || {};
    push("Finance summary");
    push(`  Completed bookings: ${r.count || 0}`);
    push(`  Gross revenue: ${inr(r.revenue || 0)}`);
    push(`  GST collected: ${inr(r.gst || 0)}`);
    push(`  Discounts given: ${inr(r.discount || 0)}`);
  } else if (template === "daily_ops") {
    const [total, completed, cancelled, searching] = await Promise.all([
      Booking.countDocuments({ createdAt: { $gte: since } }),
      Booking.countDocuments({ status: "COMPLETED", createdAt: { $gte: since } }),
      Booking.countDocuments({ status: "CANCELLED", createdAt: { $gte: since } }),
      Booking.countDocuments({ status: "SEARCHING" }),
    ]);
    push("Operations digest");
    push(`  New bookings: ${total}`);
    push(`  Completed: ${completed}`);
    push(`  Cancelled: ${cancelled}`);
    push(`  Currently unassigned (SEARCHING): ${searching}`);
  } else if (template === "driver_perf") {
    const rows = await Booking.aggregate([
      {
        $match: {
          status: "COMPLETED",
          driverId: { $ne: null },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$driverId",
          trips: { $sum: 1 },
          earnings: { $sum: "$finalFare" },
        },
      },
      { $sort: { earnings: -1 } },
      { $limit: 10 },
    ]);
    push(`Top drivers (${rows.length})`);
    for (const row of rows) {
      const d = await Driver.findById(row._id).select("fullName").lean();
      push(
        `  ${(d as any)?.fullName || "Driver"} — ${row.trips} trips, ${inr(row.earnings)}`,
      );
    }
    if (rows.length === 0) push("  No completed driver trips in this window.");
  } else if (template === "enterprise") {
    // Volume/revenue by enterprise (bookings tagged with an enterpriseId).
    const rows = await Booking.aggregate([
      {
        $match: {
          status: "COMPLETED",
          enterpriseId: { $ne: null },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$enterpriseId",
          orders: { $sum: 1 },
          revenue: { $sum: "$finalFare" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]);
    push(`Enterprise scorecard (${rows.length})`);
    for (const row of rows) {
      push(`  Enterprise …${String(row._id).slice(-6)} — ${row.orders} orders, ${inr(row.revenue)}`);
    }
    if (rows.length === 0) push("  No enterprise orders in this window.");
  } else {
    // compliance
    const [totalDrivers, blockedUsers] = await Promise.all([
      Driver.countDocuments({ isDeleted: false }),
      User.countDocuments({ isBlocked: true }),
    ]);
    push("Compliance snapshot");
    push(`  Active drivers: ${totalDrivers}`);
    push(`  Blocked users: ${blockedUsers}`);
    push("  (Document-expiry checks require the compliance module.)");
  }

  return {
    subject: `Movezy ${template} report — ${window}`,
    body: lines.join("\n"),
  };
};

/**
 * Run a single schedule now: generate + email + advance nextRunAt.
 */
export const runSchedule = async (
  schedule: IScheduledReport,
): Promise<"SENT" | "LOGGED" | "FAILED"> => {
  try {
    const { subject, body } = await generateReportContent(
      schedule.template,
      schedule.frequency,
    );

    let anySent = false;
    for (const to of schedule.recipients) {
      const sent = await sendEmail({
        to,
        subject,
        html: `<pre style="font-family:monospace">${body}</pre>`,
        text: body,
      });
      anySent = anySent || sent;
    }

    const status = isEmailConfigured() && anySent ? "SENT" : "LOGGED";
    const next = computeNextRun(new Date(), schedule.frequency, {
      dayOfWeek: schedule.dayOfWeek,
      dayOfMonth: schedule.dayOfMonth,
      hour: schedule.hour,
    });
    await ScheduledReport.findByIdAndUpdate(schedule._id, {
      lastRunAt: new Date(),
      lastStatus: status,
      nextRunAt: next,
    });
    return status;
  } catch (err) {
    console.error("[ScheduledReport] run failed:", err);
    await ScheduledReport.findByIdAndUpdate(schedule._id, {
      lastStatus: "FAILED",
    });
    return "FAILED";
  }
};

/**
 * Find and run all due active schedules.
 */
export const runDueSchedules = async (): Promise<{ ran: number }> => {
  const due = await ScheduledReport.find({
    isActive: true,
    nextRunAt: { $lte: new Date() },
  });
  for (const s of due) await runSchedule(s);
  return { ran: due.length };
};

let interval: NodeJS.Timeout | null = null;

export const startReportScheduler = () => {
  if (interval) return;
  if (process.env.REPORT_SCHEDULER_ENABLED === "false") {
    console.log("📅 Report scheduler loaded (background loop disabled by env)");
    return;
  }
  const minutes = Number(process.env.REPORT_SCHEDULER_INTERVAL_MINUTES) || 15;
  console.log(`📅 Report scheduler started — checking every ${minutes} min`);
  interval = setInterval(async () => {
    try {
      const { ran } = await runDueSchedules();
      if (ran > 0) console.log(`[ScheduledReport] ran ${ran} due report(s)`);
    } catch (err) {
      console.error("[ScheduledReport] tick failed:", err);
    }
  }, minutes * 60 * 1000);
};

export const stopReportScheduler = () => {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
};
