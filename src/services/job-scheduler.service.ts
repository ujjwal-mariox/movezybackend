import { AppConfig } from "../models/app-config.model";
import Driver from "../models/driver.model";
import Payout from "../models/payout.model";
import DispatchOffer from "../models/dispatch-offer.model";
import * as notificationService from "../services/notification.service";
import * as DriverPayoutService from "../services/driver-payout.service";
import { runAutoAssignSweep } from "../services/auto-assign.service";

/**
 * General scheduled-jobs layer.
 *
 * The automation engine evaluates RULES (admin-authored trigger/action pairs);
 * this runs fixed platform JOBS on a cadence. Same operational posture:
 * single-process interval (one Render instance), last-run persisted in
 * AppConfig so a restart never double-runs a period, a master switch the
 * panel can flip, and every job wrapped so one failure cannot kill the loop.
 *
 * Jobs:
 *  - expire-offers          every tick     lapse PENDING dispatch offers
 *  - onboarding-reminders   hourly         nudge stalled applications at 4/24/48h
 *  - auto-assign            configurable   the SAME sweep the dashboard button runs
 *  - auto-payouts           daily          CREATE payout requests (a human still
 *                                          approves and pays — no money moves alone)
 */

const TICK_MS = 5 * 60 * 1000;
let interval: NodeJS.Timeout | null = null;

const getConfig = async (key: string): Promise<any> => {
  const doc: any = await AppConfig.findOne({ key }).lean();
  return doc?.value;
};

const setConfig = async (key: string, value: any): Promise<void> => {
  await AppConfig.findOneAndUpdate(
    { key },
    { $set: { value }, $setOnInsert: { type: "STRING", category: "scheduler" } },
    { upsert: true },
  );
};

/** True when the job's cadence has elapsed since its persisted last run. */
const due = async (jobKey: string, cadenceMs: number): Promise<boolean> => {
  const last = await getConfig(`job_last_run:${jobKey}`);
  const lastMs = last ? new Date(last).getTime() : 0;
  return Date.now() - lastMs >= cadenceMs;
};

const markRan = (jobKey: string) =>
  setConfig(`job_last_run:${jobKey}`, new Date().toISOString());

// ─────────────────────────── jobs ───────────────────────────

/** Lapse dispatch offers whose window has passed. */
const expireOffers = async (): Promise<void> => {
  await DispatchOffer.updateMany(
    { response: "PENDING", expiresAt: { $lt: new Date() } },
    { $set: { response: "EXPIRED", respondedAt: new Date() } },
  );
};

/**
 * Nudge drivers whose onboarding stalled, at 4h / 24h / 48h after signup.
 * Which nudges were already sent is recorded on the driver, so a reminder
 * fires exactly once per stage regardless of restarts.
 */
const REMINDER_STAGES_HOURS = [4, 24, 48];

const onboardingReminders = async (): Promise<void> => {
  const incomplete = await Driver.find({
    isDeleted: { $ne: true },
    status: {
      $nin: ["approved", "active", "under_verification", "blocked", "rejected"],
    },
    createdAt: {
      $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // stop after a week
      $lte: new Date(Date.now() - 4 * 60 * 60 * 1000),
    },
  })
    .select("createdAt onboardingRemindersSent fullName")
    .limit(200);

  for (const driver of incomplete) {
    const ageHours =
      (Date.now() - new Date(driver.createdAt as any).getTime()) / 3_600_000;
    const sent: number[] = (driver as any).onboardingRemindersSent || [];
    const dueStage = REMINDER_STAGES_HOURS.filter(
      (h) => ageHours >= h && !sent.includes(h),
    ).pop();
    if (dueStage === undefined) continue;

    try {
      await notificationService.sendToDriver(
        driver._id as any,
        "SYSTEM",
        "Finish your Movezy registration",
        "Your application is almost there — complete your documents to start earning.",
      );
      await Driver.updateOne(
        { _id: driver._id },
        { $addToSet: { onboardingRemindersSent: dueStage } },
      );
    } catch (e) {
      console.error(
        `[scheduler] onboarding reminder failed for ${driver._id}`,
        e,
      );
    }
  }
};

/**
 * Auto-CREATE payout requests for drivers whose available balance crossed the
 * configured minimum. Strictly request-creation: the payout lands PENDING in
 * the same approval queue as a manual one and a human approves and pays it.
 * OFF by default — the admin enables `payout_auto_create_enabled` knowingly.
 */
const autoPayouts = async (): Promise<void> => {
  const enabled = await getConfig("payout_auto_create_enabled");
  if (!(enabled === true || enabled === "true")) return;
  const minAmount = Number(await getConfig("payout_min_amount")) || 500;

  const candidates = await Driver.find({
    isDeleted: { $ne: true },
    status: "approved",
    "bankDetails.accountNumber": { $exists: true, $nin: [null, ""] },
    "bankDetails.ifscCode": { $exists: true, $nin: [null, ""] },
  })
    .select("bankDetails fullName")
    .limit(500);

  for (const driver of candidates) {
    try {
      // Same balance authority the manual admin path uses — earnings minus
      // everything already requested or paid, so this can never double-pay.
      const balance = await DriverPayoutService.getDriverAvailableBalance(
        String(driver._id),
      );
      if (balance.available < minAmount) continue;

      const bank = (driver as any).bankDetails || {};
      await Payout.create({
        driverId: driver._id,
        amount: Math.floor(balance.available),
        method: "BANK",
        status: "PENDING",
        notes: "Auto-created by scheduler (threshold reached)",
        bankSnapshot: {
          accountHolderName: bank.accountHolderName,
          bankName: bank.bankName,
          accountNumber: bank.accountNumber,
          ifscCode: bank.ifscCode,
        },
        requestedByType: "Admin",
      });
    } catch (e) {
      console.error(`[scheduler] auto-payout failed for ${driver._id}`, e);
    }
  }
};

/**
 * Unattended auto-assign: the SAME sweep the dashboard button runs, on a
 * timer. OFF by default; the dashboard's Auto-assign toggle writes the same
 * key, so turning it on there now works with no browser open.
 */
const autoAssign = async (): Promise<void> => {
  const enabled = await getConfig("auto_assign_scheduler_enabled");
  if (!(enabled === true || enabled === "true")) return;
  const result = await runAutoAssignSweep();
  if (result.assigned > 0) {
    console.log(
      `[scheduler] auto-assign: ${result.assigned}/${result.evaluated} bookings assigned`,
    );
  }
};

// ─────────────────────────── loop ───────────────────────────

const runDueJobs = async (): Promise<void> => {
  const master = await getConfig("job_scheduler_enabled");
  if (master === false || master === "false") return;

  const jobs: Array<{ key: string; cadenceMs: number; run: () => Promise<void> }> = [
    { key: "expire-offers", cadenceMs: 0, run: expireOffers },
    { key: "onboarding-reminders", cadenceMs: 60 * 60 * 1000, run: onboardingReminders },
    {
      key: "auto-assign",
      cadenceMs:
        (Number(await getConfig("auto_assign_interval_min")) || 5) * 60 * 1000,
      run: autoAssign,
    },
    { key: "auto-payouts", cadenceMs: 24 * 60 * 60 * 1000, run: autoPayouts },
  ];

  for (const job of jobs) {
    try {
      if (job.cadenceMs > 0 && !(await due(job.key, job.cadenceMs))) continue;
      await job.run();
      if (job.cadenceMs > 0) await markRan(job.key);
    } catch (e) {
      console.error(`[scheduler] job ${job.key} failed`, e);
    }
  }
};

export const startJobScheduler = (): void => {
  if (process.env.JOB_SCHEDULER === "off") {
    console.log("⏲️  Job scheduler loaded (disabled by env)");
    return;
  }
  if (interval) return;
  interval = setInterval(() => {
    runDueJobs().catch((e) => console.error("[scheduler] tick failed", e));
  }, TICK_MS);
  // First pass shortly after boot so restarts don't delay due work a full tick.
  setTimeout(() => {
    runDueJobs().catch((e) => console.error("[scheduler] first run failed", e));
  }, 30_000);
  console.log("⏲️  Job scheduler started (5-min tick)");
};

export const stopJobScheduler = (): void => {
  if (interval) clearInterval(interval);
  interval = null;
};
