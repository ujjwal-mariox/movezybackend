import { Request, Response } from "express";
import { Types } from "mongoose";
import Vehicle from "../../models/vehicle.model";
import DriverKYC from "../../models/driver-kyc.model";
import Driver from "../../models/driver.model";
import {
  getExpirySummary,
  invalidateExpirySummary,
  recomputeDriverLicenceBlock,
  recomputeVehicleExpiryBlock,
  runDocumentExpiryJob,
} from "../../services/document-expiry.service";
import { auditFromRequest } from "./audit-log.controller";

/**
 * Document-expiry administration. See document-expiry.service for the model
 * (what is tracked, the nightly job, the cache, the block/unblock rules).
 */

/** GET /admin/compliance/expiry?days=30 — cached summary for the page + dashboard. */
export const expirySummary = async (req: Request, res: Response) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.locals.data = await getExpirySummary(days);
};

/** POST /admin/compliance/expiry/run — run the nightly job on demand. */
export const runExpiryNow = async (req: Request, res: Response) => {
  const result = await runDocumentExpiryJob();
  await auditFromRequest(req, {
    action: "UPDATE",
    module: "compliance",
    targetId: "document-expiry-job",
    targetType: "Job",
    description: `Ran document-expiry job manually: ${JSON.stringify(result)}`,
  });
  res.locals.data = { message: "Document expiry check completed", result };
};

const parseDate = (v: unknown): Date | null | undefined => {
  if (v === undefined) return undefined; // not supplied → leave as is
  if (v === null || v === "") return null; // explicit clear
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * PUT /admin/drivers/:id/vehicles/:vehicleId/documents
 * body: { rcExpiryDate?, insuranceExpiryDate?, pucExpiryDate? } (ISO dates, or null to clear)
 * Recomputes the vehicle's block immediately — recording a renewed date is
 * how an expired vehicle gets back on dispatch.
 */
export const updateVehicleDocuments = async (req: Request, res: Response) => {
  const { id, vehicleId } = req.params;
  const vehicle: any = await Vehicle.findOne({
    _id: vehicleId,
    driverId: id,
    isDeleted: { $ne: true },
  });
  if (!vehicle) {
    return res.status(404).json({ success: false, message: "Vehicle not found for this driver" });
  }

  const before = {
    rcExpiryDate: vehicle.rcExpiryDate,
    insuranceExpiryDate: vehicle.insuranceExpiryDate,
    pucExpiryDate: vehicle.pucExpiryDate,
  };
  const changes: string[] = [];
  for (const key of ["rcExpiryDate", "insuranceExpiryDate", "pucExpiryDate"] as const) {
    const parsed = parseDate(req.body[key]);
    if (parsed === undefined) continue;
    vehicle[key] = parsed;
    changes.push(`${key}: ${before[key] ? new Date(before[key]).toISOString().slice(0, 10) : "—"} → ${parsed ? parsed.toISOString().slice(0, 10) : "—"}`);
  }
  if (!changes.length) {
    return res.status(400).json({ success: false, message: "No valid date fields supplied" });
  }
  await vehicle.save();
  await recomputeVehicleExpiryBlock(vehicle._id);
  await invalidateExpirySummary();

  await auditFromRequest(req, {
    action: "UPDATE",
    module: "compliance",
    targetId: String(vehicle._id),
    targetType: "Vehicle",
    description: `Updated document dates for ${vehicle.vehicleNumber}: ${changes.join("; ")}`,
  });

  const fresh = await Vehicle.findById(vehicle._id).lean();
  res.locals.data = { message: "Document dates updated", vehicle: fresh };
};

/**
 * PUT /admin/drivers/:id/licence-expiry  body: { expiryDate }
 * The licence date lives on the KYC record; recording a renewed date lifts
 * the driver-level block.
 */
export const updateDriverLicenceExpiry = async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = parseDate(req.body.expiryDate);
  if (parsed === undefined || parsed === null) {
    return res.status(400).json({ success: false, message: "expiryDate (ISO date) is required" });
  }
  const driver = await Driver.findById(id).select("_id fullName");
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found" });

  const kyc = await DriverKYC.findOneAndUpdate(
    { driverId: new Types.ObjectId(id) },
    { $set: { "drivingLicense.expiryDate": parsed.toISOString().slice(0, 10) } },
    { new: true, upsert: true },
  );
  await recomputeDriverLicenceBlock(id);
  await invalidateExpirySummary();

  await auditFromRequest(req, {
    action: "UPDATE",
    module: "compliance",
    targetId: String(id),
    targetType: "Driver",
    description: `Set driving licence expiry for ${driver.fullName || id} to ${parsed.toISOString().slice(0, 10)}`,
  });

  const fresh = await Driver.findById(id).select("documentBlock isOnline").lean();
  res.locals.data = {
    message: "Licence expiry updated",
    expiryDate: kyc?.drivingLicense?.expiryDate,
    documentBlock: (fresh as any)?.documentBlock,
  };
};
