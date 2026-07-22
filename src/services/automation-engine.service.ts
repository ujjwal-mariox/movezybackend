/**
 * Automation Rule Engine.
 *
 * Evaluates active AutomationRules on an interval and executes their actions.
 * The rule model has 8 trigger types and 9 action types; this engine implements
 * a real, well-defined subset and is honest about the rest:
 *
 *   Triggers implemented: cancellation_rate, low_rating_consecutive, driver_idle
 *   Triggers acknowledged-only: cod_collection_delay, order_spike, sos_spike,
 *     revenue_drop, custom  (logged as "not evaluated" so nothing silently passes)
 *
 *   Actions executed (safe): flag_driver, warn_driver, escalate_to_admin,
 *     create_ticket, send_push_notification
 *   Actions DRY-RUN by default (destructive): suspend_driver, block_user —
 *     only enforced when the rule's action.params.enforce === true.
 *     Otherwise they are logged (audit) but NOT applied.
 */
import { Types } from "mongoose";
import AutomationRule, {
  IAutomationRule,
} from "../models/automation-rule.model";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import User from "../models/Users";
import DriverLocation from "../models/driver-location.model";
import AuditLog from "../models/audit-log.model";
import { createAuditEntry } from "../controllers/admin/audit-log.controller";
import * as NotificationService from "./notification.service";
import * as SupportService from "./support.service";

const IMPLEMENTED_TRIGGERS = new Set([
  "cancellation_rate",
  "low_rating_consecutive",
  "driver_idle",
]);

const DESTRUCTIVE_ACTIONS = new Set(["suspend_driver", "block_user"]);

interface TriggerHit {
  // Entity the rule fired for (driver or user), plus the observed value.
  targetId: Types.ObjectId;
  targetType: "Driver" | "User";
  value: number;
}

const compare = (
  value: number,
  operator: IAutomationRule["trigger"]["operator"],
  threshold: number,
): boolean => {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "lt":
      return value < threshold;
    case "gte":
      return value >= threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    default:
      return false;
  }
};

/**
 * Compute the drivers whose metric satisfies the rule's trigger.
 * Returns one TriggerHit per matching entity.
 */
const evaluateTrigger = async (
  rule: IAutomationRule,
): Promise<TriggerHit[]> => {
  const { type, operator, threshold, timeWindowDays } = rule.trigger;
  const since = new Date(
    Date.now() - (timeWindowDays || 7) * 24 * 60 * 60 * 1000,
  );

  if (type === "cancellation_rate") {
    // Per driver: cancelled-by-driver / total assigned, within the window.
    const rows = await Booking.aggregate([
      { $match: { driverId: { $ne: null }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$driverId",
          total: { $sum: 1 },
          cancelled: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "CANCELLED"] },
                    { $eq: ["$cancelledBy", "DRIVER"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    return rows
      .filter((r) => r.total > 0)
      .map((r) => ({
        targetId: r._id as Types.ObjectId,
        targetType: "Driver" as const,
        value: Math.round((r.cancelled / r.total) * 100), // percentage
      }))
      .filter((h) => compare(h.value, operator, threshold));
  }

  if (type === "low_rating_consecutive") {
    // Per driver: average rating over the window (threshold usually a low value).
    const rows = await Booking.aggregate([
      {
        $match: {
          driverId: { $ne: null },
          rating: { $gt: 0 },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: "$driverId", avg: { $avg: "$rating" }, n: { $sum: 1 } } },
    ]);
    return rows
      .filter((r) => r.n >= (rule.trigger.consecutiveCount || 1))
      .map((r) => ({
        targetId: r._id as Types.ObjectId,
        targetType: "Driver" as const,
        value: Math.round(r.avg * 100) / 100,
      }))
      .filter((h) => compare(h.value, operator, threshold));
  }

  if (type === "driver_idle") {
    // Drivers online but with no location update for > threshold minutes.
    const cutoff = new Date(Date.now() - threshold * 60 * 1000);
    const rows = await DriverLocation.find({
      isOnline: true,
      lastUpdated: { $lt: cutoff },
    }).select("driverId lastUpdated");
    return rows.map((r) => ({
      targetId: r.driverId as Types.ObjectId,
      targetType: "Driver" as const,
      value: Math.round((Date.now() - new Date(r.lastUpdated!).getTime()) / 60000),
    }));
  }

  return []; // acknowledged-only trigger types
};

/**
 * Execute a rule's action against one matched entity.
 * Destructive actions are dry-run unless the rule opts in via params.enforce.
 */
const executeAction = async (rule: IAutomationRule, hit: TriggerHit) => {
  const action = rule.action.type;
  const enforce = rule.action.params?.enforce === true;
  const isDestructive = DESTRUCTIVE_ACTIONS.has(action);
  const dryRun = isDestructive && !enforce;

  const summary = `Rule "${rule.name}" → ${action}${dryRun ? " (DRY-RUN)" : ""} on ${hit.targetType} ${hit.targetId} (observed ${hit.value})`;

  // Map the engine action to a valid AuditLog action enum value.
  const auditAction =
    action === "suspend_driver"
      ? "SUSPEND"
      : action === "block_user"
        ? "BLOCK"
        : action === "create_ticket"
          ? "CREATE"
          : action === "send_push_notification"
            ? "SEND_NOTIFICATION"
            : "UPDATE"; // warn/flag/etc.

  // Always record an audit trail for what the engine did / would do.
  const audit = () =>
    createAuditEntry({
      adminId: String(rule._id),
      adminName: "Automation Engine",
      adminEmail: "system@movezy",
      action: auditAction,
      module: "automation",
      targetId: String(hit.targetId),
      targetType: hit.targetType,
      description: `${summary}${dryRun ? " [DRY-RUN — not applied]" : ""}`,
      metadata: {
        ruleId: String(rule._id),
        engineAction: action,
        dryRun,
        observedValue: hit.value,
      },
    });

  try {
    switch (action) {
      case "warn_driver":
      case "flag_driver":
        await NotificationService.sendToDriver(
          hit.targetId,
          "SYSTEM",
          action === "warn_driver" ? "Performance Warning" : "Account Flagged",
          rule.action.params?.message ||
            `Automated review flagged your account (${rule.name}).`,
        );
        await audit();
        break;

      case "send_push_notification":
        await NotificationService.sendToDriver(
          hit.targetId,
          "SYSTEM",
          rule.action.params?.title || "Notice",
          rule.action.params?.message || rule.name,
        );
        await audit();
        break;

      case "escalate_to_admin":
        // Recorded to the audit log as a HIGH-impact escalation.
        await createAuditEntry({
          adminId: String(rule._id),
          adminName: "Automation Engine",
          adminEmail: "system@movezy",
          action: "ASSIGN",
          module: "automation",
          targetId: String(hit.targetId),
          targetType: hit.targetType,
          description: `Escalated to admin: ${summary}`,
          impactLevel: "HIGH",
          metadata: { ruleId: String(rule._id), observedValue: hit.value },
        });
        break;

      case "create_ticket":
        await SupportService.createTicket({
          driverId: hit.targetType === "Driver" ? hit.targetId : undefined,
          userId: hit.targetType === "User" ? hit.targetId : undefined,
          category: "Automation",
          subject: `Auto: ${rule.name}`,
          description: summary,
          priority: "HIGH",
        });
        await audit();
        break;

      case "suspend_driver":
        if (enforce) {
          await Driver.findByIdAndUpdate(hit.targetId, { status: "suspended" });
        }
        await audit(); // audit records DRY-RUN vs enforced
        break;

      case "block_user":
        if (enforce) {
          await User.findByIdAndUpdate(hit.targetId, { isActive: false });
        }
        await audit();
        break;

      default:
        // send_email / custom — acknowledged, audited, not executed.
        await audit();
    }
  } catch (err) {
    console.error(`[AutomationEngine] action failed: ${summary}`, err);
  }
};

/**
 * Evaluate every active rule once. Returns a summary for logging / the manual
 * "run now" admin endpoint.
 */
export const runAllRules = async (): Promise<{
  evaluated: number;
  fired: number;
  skipped: string[];
}> => {
  const rules = await AutomationRule.find({ isActive: true });
  let fired = 0;
  const skipped: string[] = [];

  for (const rule of rules) {
    if (!IMPLEMENTED_TRIGGERS.has(rule.trigger.type)) {
      skipped.push(`${rule.name} (${rule.trigger.type} not evaluated)`);
      continue;
    }
    const hits = await evaluateTrigger(rule);
    if (hits.length === 0) continue;

    // Per-target cooldown.
    //
    // Triggers describe a STANDING condition ("idle > 7 min", "rating < 3"),
    // so an unchanged situation matched again on every sweep and fired again:
    // one idle driver accumulated 116 identical nudges. The audit trail this
    // engine already writes is the record of what it last did to whom, so it
    // doubles as the cooldown ledger — one query per rule, no new collection.
    const cooldownMs = Math.max(0, (rule.cooldownMinutes ?? 720) * 60 * 1000);
    let dueHits = hits;
    if (cooldownMs > 0) {
      const recent = await AuditLog.find({
        module: "automation",
        "metadata.ruleId": String(rule._id),
        createdAt: { $gte: new Date(Date.now() - cooldownMs) },
      }).select("targetId");
      const onCooldown = new Set(recent.map((r: any) => String(r.targetId)));
      dueHits = hits.filter((h) => !onCooldown.has(String(h.targetId)));
    }

    if (dueHits.length === 0) continue;

    for (const hit of dueHits) {
      await executeAction(rule, hit);
      fired += 1;
    }
    await AutomationRule.findByIdAndUpdate(rule._id, {
      lastTriggeredAt: new Date(),
      $inc: { triggerCount: dueHits.length },
    });
  }

  return { evaluated: rules.length, fired, skipped };
};

let interval: NodeJS.Timeout | null = null;

/**
 * Start the background scheduler. Interval configurable via
 * AUTOMATION_INTERVAL_MINUTES (default 30). Set AUTOMATION_ENGINE_ENABLED=false
 * to keep the engine available (manual run) without the background loop.
 */
export const startAutomationEngine = () => {
  if (interval) return;
  if (process.env.AUTOMATION_ENGINE_ENABLED === "false") {
    console.log(
      "⚙️  Automation engine loaded (background scheduler disabled by env)",
    );
    return;
  }
  const minutes = Number(process.env.AUTOMATION_INTERVAL_MINUTES) || 30;
  console.log(`⚙️  Automation engine started — evaluating every ${minutes} min`);
  interval = setInterval(async () => {
    try {
      const result = await runAllRules();
      if (result.fired > 0 || result.skipped.length > 0) {
        console.log(
          `[AutomationEngine] evaluated ${result.evaluated} rules, fired ${result.fired}, skipped ${result.skipped.length}`,
        );
      }
    } catch (err) {
      console.error("[AutomationEngine] run failed:", err);
    }
  }, minutes * 60 * 1000);
};

export const stopAutomationEngine = () => {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
};
