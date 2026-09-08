import { Types } from "mongoose";
import Vehicle from "../models/vehicle.model";
import DriverVehicle from "../models/driver-vehicle.model";
import VehicleType from "../models/vehicle-type.model";
import Driver from "../models/driver.model";
import Booking from "../models/booking.model";
import { BodyType, FuelType as FuelTypeMaster } from "../models/master-data.model";

/**
 * One place for the rules a partner's vehicle has to obey. Three creation
 * paths (onboarding RC upload, "add another vehicle", the legacy /vehicles
 * route) and two admin paths (verify, document edits) each used to carry their
 * own partial copy of these — which is how the same registration number ended
 * up registered three times to one driver and once to somebody else.
 */

// ── Fuel ────────────────────────────────────────────────────────────────────

export const FUEL_TYPES = ["Petrol", "Diesel", "CNG", "Electric"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

/**
 * Canonical fuel label from whatever the client sent.
 *
 * The schema enum accepted "EV" while the admin's master data (which the app
 * shows as the dropdown) says "Electric" — so every electric vehicle failed
 * validation. This is the reported "error when fuel type is set to Electric".
 * Accepts the old value, the master-data value, and case/spacing variants.
 */
export const normalizeFuelType = (raw: unknown): FuelType | undefined => {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!v) return undefined;
  if (["ev", "electric", "electrical", "electronic", "battery"].includes(v))
    return "Electric";
  if (v === "petrol" || v === "gasoline") return "Petrol";
  if (v === "diesel") return "Diesel";
  if (v === "cng") return "CNG";
  return undefined;
};

// ── Two-wheeler classification ──────────────────────────────────────────────

export const TWO_WHEELER_BODY_TYPES = ["Scooter", "Bike"] as const;
export const TWO_WHEELER_FUEL_TYPES: FuelType[] = ["Petrol", "Electric"];

/**
 * Attribute rules by category. For a 2W catalog type the body type must be
 * Scooter or Bike (the truck-style Open/Closed makes no sense on a scooter)
 * and fuel is limited to Petrol or Electric. Returns a message key, or null
 * when the combination is valid.
 */
/** Active names from a master list (System Configuration), cached 5 minutes. */
const masterCache: Record<string, { names: string[]; at: number }> = {};
const activeMasterNames = async (which: "body" | "fuel"): Promise<string[]> => {
  const hit = masterCache[which];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.names;
  try {
    const Model: any = which === "body" ? BodyType : FuelTypeMaster;
    const rows = await Model.find({ isActive: true }).select("name").lean();
    masterCache[which] = { names: rows.map((r: any) => String(r.name || "")).filter(Boolean), at: Date.now() };
  } catch {
    masterCache[which] = { names: hit?.names || [], at: Date.now() };
  }
  return masterCache[which].names;
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Two-wheelers: Scooter/Bike on Petrol/Electric. Everything else: the fuel
 * must be one of the admin's Fuel Types and the body one of the admin's Body
 * Types (when that list is populated) — the same lists the driver app shows,
 * so nothing the admin adds there is rejected here, and nothing else is let in.
 */
export const validateVehicleAttributes = async (
  categoryCode: string | undefined | null,
  bodyType: string | undefined | null,
  fuelType: string | undefined,
): Promise<string | null> => {
  const fuel = fuelType ? String(fuelType).trim() : "";
  if (categoryCode === "2W") {
    if (bodyType && !TWO_WHEELER_BODY_TYPES.some((b) => sameName(b, String(bodyType)))) {
      return "invalid_body_type_for_two_wheeler";
    }
    if (fuel && !TWO_WHEELER_FUEL_TYPES.some((f) => sameName(f, fuel))) {
      return "invalid_fuel_type_for_two_wheeler";
    }
    return null;
  }
  if (fuel) {
    const fuels = await activeMasterNames("fuel");
    const allowed = fuels.length ? fuels : [...FUEL_TYPES];
    if (!allowed.some((f) => sameName(f, fuel))) return "invalid_fuel_type";
  }
  if (bodyType) {
    const bodies = await activeMasterNames("body");
    if (bodies.length && !bodies.some((b) => sameName(b, String(bodyType)))) return "invalid_body_type";
  }
  return null;
};

/** Canonical casing for the 2W body types so "bike"/"BIKE" store as "Bike". */
export const normalizeBodyType = (raw: unknown): string | undefined => {
  const v = String(raw ?? "").trim();
  if (!v) return undefined;
  const hit = [...TWO_WHEELER_BODY_TYPES, "Open", "Closed"].find(
    (b) => b.toLowerCase() === v.toLowerCase(),
  );
  return hit ?? v;
};

// ── Duplicate registration ─────────────────────────────────────────────────

export const normalizeVehicleNumber = (raw: unknown): string =>
  String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

export interface VehicleConflict {
  /** This driver already registered this number (re-submit → update in place). */
  own?: any;
  /** A DIFFERENT partner holds this number — must be refused. */
  other?: any;
}

/**
 * Who, if anyone, already has this registration number. Compared on the
 * normalised form so "MH 12 AC 1965" and "MH12AC1965" are the same vehicle.
 * Soft-deleted rows don't count: a sold vehicle can be re-registered by its
 * new owner once the previous owner removes it.
 */
export const findVehicleConflict = async (
  vehicleNumber: string,
  driverId: string | Types.ObjectId,
): Promise<VehicleConflict> => {
  const wanted = normalizeVehicleNumber(vehicleNumber);
  if (!wanted) return {};
  // The stored value is uppercased but may carry spaces from older builds, so
  // match on a normalised regex rather than equality.
  const pattern = wanted.split("").join("[^A-Z0-9]*");
  const rows = await Vehicle.find({
    vehicleNumber: { $regex: `^[^A-Z0-9]*${pattern}[^A-Z0-9]*$`, $options: "i" },
    isDeleted: { $ne: true },
  }).lean();
  const me = String(driverId);
  const own = rows.find((r: any) => String(r.driverId) === me);
  const other = rows.find((r: any) => String(r.driverId) !== me);
  return { own, other };
};

// ── Dispatch row sync ──────────────────────────────────────────────────────

/**
 * The single rule for whether a vehicle can receive bookings.
 *
 * `DriverVehicle.isActive` is what dispatch reads. It used to be set from
 * three different places with three different meanings (approved? selected?
 * onboarding?), which is why nine drivers had several rows active at once.
 * Now it is DERIVED, every time, from:
 *   approved by admin
 *   ∧ the driver's currently selected (primary) vehicle
 *   ∧ not blocked for an expired document
 *   ∧ the driver's own licence not blocked
 * Call this after anything that could change any of those.
 */
export const syncDispatchRow = async (
  vehicle: any,
  opts: { driverDocBlocked?: boolean } = {},
): Promise<void> => {
  if (!vehicle?.vehicleNumber) return;

  let typeId: Types.ObjectId | undefined = vehicle.vehicleTypeId;
  if (!typeId && vehicle.vehicleType) {
    const fallback = await VehicleType.findOne({
      categoryCode: vehicle.vehicleType,
      isDefaultForCategory: true,
      isActive: true,
    }).select("_id");
    typeId = fallback?._id as Types.ObjectId | undefined;
  }
  if (!typeId) return; // nothing to dispatch on; logged by callers already

  let driverBlocked = opts.driverDocBlocked;
  if (driverBlocked === undefined) {
    const d = await Driver.findById(vehicle.driverId)
      .select("documentBlock")
      .lean();
    driverBlocked = !!(d as any)?.documentBlock?.blocked;
  }

  const active =
    vehicle.isDeleted !== true &&
    vehicle.verificationStatus === "approved" &&
    vehicle.isPrimary === true &&
    !vehicle.dispatchBlock?.blocked &&
    !driverBlocked;

  await DriverVehicle.findOneAndUpdate(
    { registrationNumber: normalizeVehicleNumber(vehicle.vehicleNumber) },
    {
      $set: {
        driverId: vehicle.driverId,
        vehicleTypeId: typeId,
        isActive: active,
        isDeleted: vehicle.isDeleted === true,
      },
    },
    { upsert: true, new: true },
  );
};

/** Re-derive every dispatch row a driver has. */
export const syncDriverDispatchRows = async (
  driverId: string | Types.ObjectId,
): Promise<void> => {
  const d = await Driver.findById(driverId).select("documentBlock").lean();
  const driverDocBlocked = !!(d as any)?.documentBlock?.blocked;
  const vehicles = await Vehicle.find({
    driverId: new Types.ObjectId(String(driverId)),
  }).lean();
  for (const v of vehicles) {
    await syncDispatchRow(v, { driverDocBlocked });
  }
  // Ghost rows: dispatch entries whose registration no longer matches any of
  // this driver's vehicle records (legacy formatting, re-registered numbers).
  const liveNumbers = vehicles
    .filter((v: any) => v.isDeleted !== true)
    .map((v: any) => normalizeVehicleNumber(v.vehicleNumber))
    .filter(Boolean);
  await DriverVehicle.updateMany(
    {
      driverId: new Types.ObjectId(String(driverId)),
      registrationNumber: { $nin: liveNumbers },
      isActive: true,
    },
    { $set: { isActive: false, isOnline: false } },
  );
};

// ── Active (primary) vehicle ───────────────────────────────────────────────

export const getActiveVehicle = async (driverId: string | Types.ObjectId) =>
  Vehicle.findOne({
    driverId: new Types.ObjectId(String(driverId)),
    isPrimary: true,
    isDeleted: { $ne: true },
  }).lean();

/**
 * Make one vehicle the partner's selected vehicle and demote the rest.
 * Exactly one primary per driver, always. Refuses mid-trip: a booking was
 * matched on the current vehicle's type, and swapping underneath it would
 * make the trip's vehicle record a lie.
 */
export const setActiveVehicle = async (
  driverId: string | Types.ObjectId,
  vehicleId: string | Types.ObjectId,
): Promise<{ ok: true; vehicle: any } | { ok: false; msg: string }> => {
  const did = new Types.ObjectId(String(driverId));
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    driverId: did,
    isDeleted: { $ne: true },
  });
  if (!vehicle) return { ok: false, msg: "vehicle_not_found" };
  if (vehicle.verificationStatus !== "approved")
    return { ok: false, msg: "vehicle_not_approved" };
  if (!vehicle.onboardingFeePaid) return { ok: false, msg: "vehicle_fee_unpaid" };
  if ((vehicle as any).dispatchBlock?.blocked)
    return { ok: false, msg: "vehicle_documents_expired" };

  const activeTrip = await Booking.exists({
    driverId: did,
    status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
  });
  if (activeTrip) return { ok: false, msg: "active_trip_in_progress" };

  await Vehicle.updateMany(
    { driverId: did, _id: { $ne: vehicle._id } },
    { $set: { isPrimary: false } },
  );
  vehicle.isPrimary = true;
  await vehicle.save();
  await syncDriverDispatchRows(did);
  return { ok: true, vehicle: vehicle.toObject() };
};

/**
 * After admin approval: if the driver has no selected vehicle among their
 * approved ones, this one becomes it. Otherwise it stays approved-but-idle
 * until the partner switches to it — an approval must never yank bookings
 * onto a different vehicle under a partner mid-shift.
 */
export const ensurePrimaryAfterApproval = async (
  vehicle: any,
): Promise<void> => {
  const did = new Types.ObjectId(String(vehicle.driverId));
  const currentPrimary = await Vehicle.findOne({
    driverId: did,
    isPrimary: true,
    isDeleted: { $ne: true },
  }).lean();
  const primaryIsUsable =
    currentPrimary && (currentPrimary as any).verificationStatus === "approved";
  if (!primaryIsUsable) {
    await Vehicle.updateMany(
      { driverId: did, _id: { $ne: vehicle._id } },
      { $set: { isPrimary: false } },
    );
    await Vehicle.updateOne({ _id: vehicle._id }, { $set: { isPrimary: true } });
  }
  await syncDriverDispatchRows(did);
};

// ── Booking ↔ vehicle stamp ────────────────────────────────────────────────

/**
 * Record which of the driver's vehicles is doing a trip. Bookings only ever
 * referenced the vehicle TYPE, so per-vehicle history and earnings — which
 * the client asked for — were impossible to compute. Prefers the selected
 * vehicle; falls back to a vehicle of the booking's type, then any vehicle,
 * so legacy data can still be attributed.
 */
export const pickVehicleForBooking = async (
  driverId: string | Types.ObjectId,
  vehicleTypeId?: Types.ObjectId | string | null,
): Promise<{ vehicleId: Types.ObjectId; vehicleNumber: string } | null> => {
  const did = new Types.ObjectId(String(driverId));
  const vehicles = await Vehicle.find({ driverId: did, isDeleted: { $ne: true } })
    .select("vehicleNumber vehicleTypeId isPrimary verificationStatus createdAt")
    .sort({ isPrimary: -1, createdAt: 1 })
    .lean();
  if (!vehicles.length) return null;
  const wantedType = vehicleTypeId ? String(vehicleTypeId) : null;
  const chosen =
    vehicles.find((v: any) => v.isPrimary) ??
    (wantedType
      ? vehicles.find((v: any) => String(v.vehicleTypeId) === wantedType)
      : undefined) ??
    vehicles[0];
  return {
    vehicleId: chosen._id as Types.ObjectId,
    vehicleNumber: String((chosen as any).vehicleNumber || ""),
  };
};

export const stampVehicleOnBooking = async (
  bookingId: string | Types.ObjectId,
  driverId: string | Types.ObjectId,
): Promise<void> => {
  const booking = await Booking.findById(bookingId).select("vehicleTypeId").lean();
  const pick = await pickVehicleForBooking(driverId, (booking as any)?.vehicleTypeId);
  if (!pick) return;
  await Booking.updateOne(
    { _id: bookingId },
    { $set: { vehicleId: pick.vehicleId, vehicleNumber: pick.vehicleNumber } },
  );
};
