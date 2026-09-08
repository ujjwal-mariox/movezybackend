import { Types } from "mongoose";
import Vehicle from "../models/vehicle.model";
import Driver from "../models/driver.model";
import DriverKYC from "../models/driver-kyc.model";
import { cache } from "../utils/redis.util";
import * as NotificationService from "./notification.service";
import { syncDriverDispatchRows } from "./vehicle-lifecycle.service";

/**
 * Document expiry — how it is tracked, cached and enforced.
 *
 * WHAT IS TRACKED
 *   Driver : driving licence expiry (DriverKyc.drivingLicense.expiryDate)
 *   Vehicle: RC, insurance and PUC expiry (Vehicle.rcExpiryDate / …)
 *
 * WHERE THE DATES COME FROM
 *   Captured when the partner registers the vehicle (optional at that point so
 *   onboarding is never blocked on paperwork they don't have to hand) and
 *   editable by the admin from the driver's vehicle panel.
 *
 * THE DAILY JOB (runDocumentExpiryJob, via job-scheduler)
 *   1. Reminders at 30 / 15 / 7 days before expiry, to the driver (push +
 *      in-app notification). Which reminders went out is recorded on the
 *      document itself, keyed by the expiry date, so a re-run never repeats
 *      one and a renewed date starts the sequence again.
 *   2. Enforcement the day after expiry: the vehicle is marked
 *      `dispatchBlock` (or the driver `documentBlock` for the licence), the
 *      driver is taken offline, and every dispatch row is re-derived — so an
 *      expired vehicle simply stops receiving bookings. Nothing is deleted.
 *   3. Clearing: when the admin records a renewed date in the future, the
 *      same recompute lifts the block on the next save (called directly from
 *      the admin endpoints, not only from the nightly job).
 *
 * THE CACHE
 *   The admin summary (counts + the expiring/expired lists) is the expensive
 *   query — it walks every driver and vehicle. It is cached in Redis for 15
 *   minutes under `compliance:expiry-summary` and invalidated by the job and
 *   by any admin edit of a date, so the compliance page is instant and always
 *   at most one edit stale. The per-document state (`dispatchBlock`,
 *   `documentBlock`, `expiryReminders`) lives on the documents themselves:
 *   that is the durable cache the dispatch path reads, so dispatch never has
 *   to evaluate dates at request time.
 */

export const REMINDER_DAYS = [30, 15, 7] as const;
const SUMMARY_CACHE_KEY = "compliance:expiry-summary";
const SUMMARY_TTL_SEC = 15 * 60;

const DOC_LABELS: Record<string, string> = {
  rc: "Registration certificate (RC)",
  insurance: "Insurance",
  puc: "PUC certificate",
  licence: "Driving licence",
};

const startOfToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Whole days from today to `date` (negative = already expired). */
export const daysUntil = (date: Date | string | null | undefined): number | null => {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - startOfToday().getTime()) / 86_400_000);
};

const vehicleDocs = (v: any): { key: string; date: Date | null }[] => [
  { key: "rc", date: v.rcExpiryDate ? new Date(v.rcExpiryDate) : null },
  { key: "insurance", date: v.insuranceExpiryDate ? new Date(v.insuranceExpiryDate) : null },
  { key: "puc", date: v.pucExpiryDate ? new Date(v.pucExpiryDate) : null },
];

// ── Recompute (idempotent) ─────────────────────────────────────────────────

/**
 * Derive a vehicle's block state from its dates. Safe to call any time;
 * returns true when the state changed.
 */
export const recomputeVehicleExpiryBlock = async (
  vehicleId: Types.ObjectId | string,
): Promise<boolean> => {
  const v: any = await Vehicle.findById(vehicleId);
  if (!v) return false;
  const expired = vehicleDocs(v)
    .filter((d) => d.date && (daysUntil(d.date) ?? 1) < 0)
    .map((d) => `${DOC_LABELS[d.key]} expired on ${d.date!.toISOString().slice(0, 10)}`);

  const wasBlocked = !!v.dispatchBlock?.blocked;
  const nowBlocked = expired.length > 0;
  const reasonsChanged =
    JSON.stringify(v.dispatchBlock?.reasons || []) !== JSON.stringify(expired);
  if (wasBlocked === nowBlocked && !reasonsChanged) return false;

  v.dispatchBlock = {
    blocked: nowBlocked,
    reasons: expired,
    blockedAt: nowBlocked ? v.dispatchBlock?.blockedAt || new Date() : undefined,
  };
  await v.save();
  await syncDriverDispatchRows(v.driverId);
  await cache.del(SUMMARY_CACHE_KEY);
  return true;
};

/** Same for the driver's licence. */
export const recomputeDriverLicenceBlock = async (
  driverId: Types.ObjectId | string,
): Promise<boolean> => {
  const kyc: any = await DriverKYC.findOne({ driverId }).select("drivingLicense").lean();
  const driver: any = await Driver.findById(driverId);
  if (!driver) return false;
  const days = daysUntil(kyc?.drivingLicense?.expiryDate);
  const expired = days !== null && days < 0;
  const reasons = expired
    ? [`${DOC_LABELS.licence} expired on ${new Date(kyc.drivingLicense.expiryDate).toISOString().slice(0, 10)}`]
    : [];

  const wasBlocked = !!driver.documentBlock?.blocked;
  if (wasBlocked === expired) return false;

  driver.documentBlock = {
    blocked: expired,
    reasons,
    blockedAt: expired ? new Date() : undefined,
  };
  if (expired && driver.isOnline) driver.isOnline = false;
  await driver.save();
  await syncDriverDispatchRows(driver._id);
  await cache.del(SUMMARY_CACHE_KEY);
  return true;
};

// ── Reminders ──────────────────────────────────────────────────────────────

const shouldRemind = (days: number | null): number | null => {
  if (days === null) return null;
  return (REMINDER_DAYS as readonly number[]).includes(days) ? days : null;
};

const remindDriver = async (
  driverId: Types.ObjectId,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<void> => {
  try {
    await NotificationService.sendToDriver(driverId, "SYSTEM", title, body, data);
  } catch (e) {
    console.error("[doc-expiry] reminder failed", e);
  }
};

// ── The nightly job ────────────────────────────────────────────────────────

export const runDocumentExpiryJob = async (): Promise<{
  vehiclesChecked: number;
  vehicleReminders: number;
  vehiclesBlocked: number;
  driversChecked: number;
  licenceReminders: number;
  driversBlocked: number;
}> => {
  const out = {
    vehiclesChecked: 0,
    vehicleReminders: 0,
    vehiclesBlocked: 0,
    driversChecked: 0,
    licenceReminders: 0,
    driversBlocked: 0,
  };

  // Vehicles: only those with at least one date to check.
  const vehicles: any[] = await Vehicle.find({
    isDeleted: { $ne: true },
    $or: [
      { rcExpiryDate: { $ne: null } },
      { insuranceExpiryDate: { $ne: null } },
      { pucExpiryDate: { $ne: null } },
    ],
  });

  for (const v of vehicles) {
    out.vehiclesChecked++;
    let dirty = false;
    for (const doc of vehicleDocs(v)) {
      if (!doc.date) continue;
      const days = daysUntil(doc.date);
      const remindAt = shouldRemind(days);
      if (remindAt === null) continue;

      const reminders: any[] = v.expiryReminders || [];
      let entry = reminders.find(
        (r) =>
          r.doc === doc.key &&
          r.expiryDate &&
          new Date(r.expiryDate).getTime() === doc.date!.getTime(),
      );
      if (!entry) {
        entry = { doc: doc.key, expiryDate: doc.date, daysSent: [] };
        reminders.push(entry);
      }
      if (entry.daysSent.includes(remindAt)) continue;

      await remindDriver(
        v.driverId,
        `${DOC_LABELS[doc.key]} expires in ${remindAt} days`,
        `${DOC_LABELS[doc.key]} for ${v.vehicleNumber} expires on ${doc.date.toISOString().slice(0, 10)}. Renew it to keep receiving bookings.`,
        { type: "DOCUMENT_EXPIRY", vehicleId: String(v._id), doc: doc.key },
      );
      entry.daysSent.push(remindAt);
      v.expiryReminders = reminders;
      dirty = true;
      out.vehicleReminders++;
    }
    if (dirty) await v.save();

    const wasBlocked = !!v.dispatchBlock?.blocked;
    const changed = await recomputeVehicleExpiryBlock(v._id);
    if (changed && !wasBlocked) {
      const fresh: any = await Vehicle.findById(v._id).select("dispatchBlock vehicleNumber").lean();
      if (fresh?.dispatchBlock?.blocked) {
        out.vehiclesBlocked++;
        await remindDriver(
          v.driverId,
          "Vehicle paused — document expired",
          `${v.vehicleNumber}: ${fresh.dispatchBlock.reasons.join("; ")}. It will not receive bookings until the document is renewed.`,
          { type: "DOCUMENT_EXPIRED", vehicleId: String(v._id) },
        );
      }
    }
  }

  // Drivers: licence.
  const kycs: any[] = await DriverKYC.find({
    "drivingLicense.expiryDate": { $exists: true, $ne: "" },
  })
    .select("driverId drivingLicense.expiryDate")
    .lean();

  for (const k of kycs) {
    out.driversChecked++;
    const days = daysUntil(k.drivingLicense?.expiryDate);
    const remindAt = shouldRemind(days);
    if (remindAt !== null) {
      const driver: any = await Driver.findById(k.driverId).select("licenceExpiryReminders");
      if (driver) {
        const expiry = new Date(k.drivingLicense.expiryDate);
        const rec = driver.licenceExpiryReminders || {};
        const sameDate =
          rec.expiryDate && new Date(rec.expiryDate).getTime() === expiry.getTime();
        const sent: number[] = sameDate ? rec.daysSent || [] : [];
        if (!sent.includes(remindAt)) {
          await remindDriver(
            k.driverId,
            `Driving licence expires in ${remindAt} days`,
            `Your driving licence expires on ${expiry.toISOString().slice(0, 10)}. Renew it to keep driving with Movezy.`,
            { type: "DOCUMENT_EXPIRY", doc: "licence" },
          );
          driver.licenceExpiryReminders = { expiryDate: expiry, daysSent: [...sent, remindAt] };
          await driver.save();
          out.licenceReminders++;
        }
      }
    }
    const before: any = await Driver.findById(k.driverId).select("documentBlock").lean();
    const changed = await recomputeDriverLicenceBlock(k.driverId);
    if (changed && !before?.documentBlock?.blocked) {
      const after: any = await Driver.findById(k.driverId).select("documentBlock").lean();
      if (after?.documentBlock?.blocked) {
        out.driversBlocked++;
        await remindDriver(
          k.driverId,
          "Account paused — driving licence expired",
          `${after.documentBlock.reasons.join("; ")}. Upload the renewed licence to go online again.`,
          { type: "DOCUMENT_EXPIRED", doc: "licence" },
        );
      }
    }
  }

  await cache.del(SUMMARY_CACHE_KEY);
  console.log("[doc-expiry]", JSON.stringify(out));
  return out;
};

// ── Admin summary (cached) ─────────────────────────────────────────────────

export interface ExpiryRow {
  kind: "vehicle" | "driver";
  driverId: string;
  driverName: string;
  driverCode?: string;
  mobileNumber?: string;
  vehicleId?: string;
  vehicleNumber?: string;
  doc: string;
  docLabel: string;
  expiryDate: string;
  daysRemaining: number;
  status: "expired" | "expiring" | "valid";
  blocked: boolean;
}

export const getExpirySummary = async (
  withinDays = 30,
): Promise<{ generatedAt: string; expired: number; expiring: number; rows: ExpiryRow[] }> => {
  const cacheKey = `${SUMMARY_CACHE_KEY}:${withinDays}`;
  const cached = await cache.get<any>(cacheKey);
  if (cached) return cached;

  const rows: ExpiryRow[] = [];

  const vehicles: any[] = await Vehicle.find({
    isDeleted: { $ne: true },
    $or: [
      { rcExpiryDate: { $ne: null } },
      { insuranceExpiryDate: { $ne: null } },
      { pucExpiryDate: { $ne: null } },
    ],
  })
    .populate("driverId", "fullName mobileNumber driverCode")
    .lean();

  for (const v of vehicles) {
    const d: any = v.driverId || {};
    for (const doc of vehicleDocs(v)) {
      if (!doc.date) continue;
      const days = daysUntil(doc.date);
      if (days === null || days > withinDays) continue;
      rows.push({
        kind: "vehicle",
        driverId: String(d._id || v.driverId),
        driverName: d.fullName || "",
        driverCode: d.driverCode,
        mobileNumber: d.mobileNumber,
        vehicleId: String(v._id),
        vehicleNumber: v.vehicleNumber,
        doc: doc.key,
        docLabel: DOC_LABELS[doc.key],
        expiryDate: doc.date.toISOString().slice(0, 10),
        daysRemaining: days,
        status: days < 0 ? "expired" : "expiring",
        blocked: !!v.dispatchBlock?.blocked,
      });
    }
  }

  const kycs: any[] = await DriverKYC.find({
    "drivingLicense.expiryDate": { $exists: true, $ne: "" },
  })
    .populate("driverId", "fullName mobileNumber driverCode documentBlock")
    .lean();
  for (const k of kycs) {
    const d: any = k.driverId || {};
    const days = daysUntil(k.drivingLicense?.expiryDate);
    if (days === null || days > withinDays) continue;
    rows.push({
      kind: "driver",
      driverId: String(d._id || k.driverId),
      driverName: d.fullName || "",
      driverCode: d.driverCode,
      mobileNumber: d.mobileNumber,
      doc: "licence",
      docLabel: DOC_LABELS.licence,
      expiryDate: new Date(k.drivingLicense.expiryDate).toISOString().slice(0, 10),
      daysRemaining: days,
      status: days < 0 ? "expired" : "expiring",
      blocked: !!d.documentBlock?.blocked,
    });
  }

  rows.sort((a, b) => a.daysRemaining - b.daysRemaining);
  const result = {
    generatedAt: new Date().toISOString(),
    expired: rows.filter((r) => r.status === "expired").length,
    expiring: rows.filter((r) => r.status === "expiring").length,
    rows,
  };
  await cache.set(cacheKey, result, SUMMARY_TTL_SEC);
  return result;
};

export const invalidateExpirySummary = async (): Promise<void> => {
  for (const d of [7, 15, 30, 60, 90]) await cache.del(`${SUMMARY_CACHE_KEY}:${d}`);
  await cache.del(SUMMARY_CACHE_KEY);
};
