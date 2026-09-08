import { FareConfig } from "../models/app-config.model";
import VehicleType from "../models/vehicle-type.model";
import { Types } from "mongoose";
import { resolveRates, type EffectiveRates } from "./vehicle-rate.service";
import { computeBookingTax } from "./tax.service";
import type { ITaxBreakdown } from "../models/tax-breakdown.schema";

export interface FareBreakdown {
  baseFare: number;
  distanceCharge: number;
  timeCharge: number;
  surgeCharge: number;
  surgeMultiplier: number;
  addonCharges: number;
  /**
   * Per-stop charge, reported separately.
   *
   * It used to be folded into `addonCharges`, so a customer who added 2 stops
   * and picked no add-ons saw "Add-on services ₹60" — a charge attributed to
   * services they never chose — and the app's "Extra stops" row could never
   * render. The subtotal already added the two separately, so splitting the
   * REPORTED figure changes attribution only, never the amount paid.
   */
  stopCharges: number;
  loadingUnloadingCharge: number;
  waitingCharge: number;
  tollCharges: number;
  subtotal: number;
  gstAmount: number;
  gstPercentage: number;
  promoDiscount: number;
  coinDiscount: number;
  totalDiscount: number;
  finalFare: number;
  // The REAL free-waiting terms, so clients stop hardcoding them. The app was
  // promising "Free 50 mins" on one line and "65 mins free" on the next (and
  // "beyond 60 minutes" in the terms sheet) while this service actually bills
  // after `freeWaitingMinutes` — a 5-6x over-promise the app had no way to know
  // about, because these values were never returned.
  freeWaitingMinutes: number;
  waitingChargePerMin: number;
  /** Which rate card priced this quote — "CITY" when a city override matched. */
  rateSource?: "DEFAULT" | "CITY";
  rateCity?: string;
  /** The label of the surge window that applied, if any (for the receipt). */
  surgeLabel?: string;
  /** CGST+SGST / IGST split of gstAmount, when a tax context was supplied. */
  taxBreakdown?: ITaxBreakdown;
}

export interface FareCalculationInput {
  vehicleTypeId: Types.ObjectId;
  distanceKm: number;
  durationMin: number;
  isScheduled?: boolean;
  scheduledTime?: Date;
  serviceType?: "WITHIN_CITY" | "OUTSTATION";
  /**
   * Pickup city (as resolved by vehicle-rate.service.resolveBookingCity).
   * Selects the city rate card; null/undefined prices on the Default card.
   */
  city?: string | null;
  /**
   * Where the goods are handed over and who is billed — decides whether GST
   * is CGST+SGST or IGST. Optional: quotes without it get a plain GST figure.
   */
  taxContext?: {
    pickup?: { lat?: number | null; lng?: number | null; city?: string | null; state?: string | null } | null;
    customerGstin?: string | null;
  };
  addons?: {
    addonId: Types.ObjectId;
    price: number;
    quantity: number;
    /** How to interpret `price`. Defaults to FIXED when the caller omits it. */
    priceType?: "FIXED" | "PERCENTAGE" | "PER_FLOOR" | "PER_KG";
    /** Floors to carry (PER_FLOOR) / weight in kg (PER_KG), when known. */
    units?: number;
  }[];
  loadingUnloadingCharge?: number;
  tollCharges?: number;
  promoDiscount?: number;
  coinDiscount?: number;
  stops?: number; // Number of additional stops
}

// ── Surge windows ───────────────────────────────────────────────────────────

export interface SurgeWindow {
  label?: string;
  startHour: number;
  endHour: number;
  multiplier: number;
}

/** Inclusive start, exclusive end; wraps midnight when start > end (22 → 6). */
const hourInWindow = (hour: number, w: SurgeWindow): boolean =>
  w.startHour <= w.endHour
    ? hour >= w.startHour && hour < w.endHour
    : hour >= w.startHour || hour < w.endHour;

/**
 * The peak and night windows in force. Multi-row windows replaced the single
 * start/end/multiplier trio; a config that predates the arrays is read
 * through its legacy fields so nothing changes until the admin edits it.
 */
export const surgeWindowsFor = (
  fareConfig: any,
): { peak: SurgeWindow[]; night: SurgeWindow[] } => {
  const clean = (rows: any[]): SurgeWindow[] =>
    (Array.isArray(rows) ? rows : [])
      .filter(
        (w) =>
          w &&
          Number.isFinite(Number(w.startHour)) &&
          Number.isFinite(Number(w.endHour)) &&
          Number(w.multiplier) > 1,
      )
      .map((w) => ({
        label: w.label,
        startHour: Number(w.startHour),
        endHour: Number(w.endHour),
        multiplier: Number(w.multiplier),
      }));

  let peak = clean(fareConfig?.peakWindows);
  let night = clean(fareConfig?.nightWindows);

  if (!peak.length && Number(fareConfig?.peakHourSurgeMultiplier) > 1) {
    peak = [
      {
        label: "Peak",
        startHour: Number(fareConfig.peakHourStart ?? 8),
        endHour: Number(fareConfig.peakHourEnd ?? 10),
        multiplier: Number(fareConfig.peakHourSurgeMultiplier),
      },
    ];
  }
  if (!night.length && Number(fareConfig?.nightSurgeMultiplier) > 1) {
    night = [
      {
        label: "Night",
        startHour: Number(fareConfig.nightSurgeStartHour ?? 22),
        endHour: Number(fareConfig.nightSurgeEndHour ?? 6),
        multiplier: Number(fareConfig.nightSurgeMultiplier),
      },
    ];
  }
  return { peak, night };
};

/**
 * Surge for a moment in time. Peak and night windows are evaluated together
 * and the HIGHEST matching multiplier applies — they never compound, so a
 * window drawn to overlap another can't produce a 1.5 × 1.8 = 2.7× fare
 * nobody configured.
 */
export const surgeAt = (
  fareConfig: any,
  when: Date = new Date(),
): { multiplier: number; label?: string } => {
  const hour = when.getHours();
  const { peak, night } = surgeWindowsFor(fareConfig);
  let best = { multiplier: 1, label: undefined as string | undefined };
  for (const w of [...peak, ...night]) {
    if (hourInWindow(hour, w) && w.multiplier > best.multiplier) {
      best = { multiplier: w.multiplier, label: w.label };
    }
  }
  return best;
};

// ── Fare ────────────────────────────────────────────────────────────────────

/**
 * Calculate fare for a booking
 */
export const calculateFare = async (
  input: FareCalculationInput,
): Promise<FareBreakdown> => {
  // Get vehicle type pricing
  const vehicleType = await VehicleType.findById(input.vehicleTypeId);
  if (!vehicleType) {
    throw new Error("Invalid vehicle type");
  }

  // Get fare config
  const fareConfig = await FareConfig.findOne({ isActive: true });
  const gstPercentage = fareConfig?.gstPercentage || 5;

  // The rate card: this vehicle type's Default, or its override for the
  // pickup city. Minimum fare and free waiting come from the same card, so
  // a bike's floor no longer has to equal a truck's.
  const rates: EffectiveRates = resolveRates(vehicleType, fareConfig, input.city);
  const minimumFare = rates.minimumFare;

  // Calculate base fare
  const baseFare = rates.baseFare;

  // Calculate distance charge
  const chargeableDistance = Math.max(
    0,
    input.distanceKm - vehicleType.minDistanceKm,
  );
  const distanceCharge = chargeableDistance * rates.perKmRate;

  // Calculate time charge
  const timeCharge = input.durationMin * rates.perMinuteRate;

  // Get surge multiplier
  const surge = surgeAt(fareConfig, input.scheduledTime);
  const surgeMultiplier = surge.multiplier;
  const baseFareWithSurge = baseFare + distanceCharge + timeCharge;
  const surgeCharge =
    surgeMultiplier > 1 ? baseFareWithSurge * (surgeMultiplier - 1) : 0;

  // Calculate addon charges.
  //
  // This used to be a flat `price * quantity` for every add-on, ignoring
  // priceType entirely — so Insurance, seeded as 2% of order value, charged a
  // flat ₹2 (₹2 instead of ₹20 on a ₹1,000 booking).
  //
  // PERCENTAGE is taken on the trip value (base + distance + time + surge) —
  // i.e. what the delivery itself is worth, before other add-ons, stops, tolls
  // or discounts. That keeps it independent of add-on ordering and stops two
  // percentage add-ons from compounding each other.
  const tripValue = baseFare + distanceCharge + timeCharge + surgeCharge;

  let addonCharges = 0;
  if (input.addons && input.addons.length > 0) {
    addonCharges = input.addons.reduce((sum, addon) => {
      const qty = addon.quantity || 1;
      switch (addon.priceType) {
        case "PERCENTAGE":
          return sum + (tripValue * addon.price) / 100;
        case "PER_FLOOR":
        case "PER_KG":
          // `units` = floors / kg. Falls back to quantity until the app
          // captures floor count (the design's floor picker isn't built yet).
          return sum + addon.price * (addon.units ?? qty);
        case "FIXED":
        default:
          return sum + addon.price * qty;
      }
    }, 0);
  }

  // Additional stop charges (₹30 per stop)
  const stopCharges = (input.stops || 0) * 30;

  // Loading/Unloading charges
  const loadingUnloadingCharge = input.loadingUnloadingCharge || 0;

  // Toll charges
  const tollCharges = input.tollCharges || 0;

  // Calculate subtotal
  let subtotal =
    baseFare +
    distanceCharge +
    timeCharge +
    surgeCharge +
    addonCharges +
    stopCharges +
    loadingUnloadingCharge +
    tollCharges;

  // Apply minimum fare
  if (subtotal < minimumFare) {
    subtotal = minimumFare;
  }

  // Calculate GST — and, when we know where the trip starts / who is billed,
  // how it splits (CGST+SGST within the company's state, IGST otherwise).
  const gstAmount = (subtotal * gstPercentage) / 100;
  const totalWithGst = subtotal + gstAmount;
  let taxBreakdown: ITaxBreakdown | undefined;
  if (input.taxContext) {
    try {
      taxBreakdown = await computeBookingTax({
        taxableAmount: Math.round(subtotal * 100) / 100,
        gstPercentage,
        pickup: input.taxContext.pickup,
        customerGstin: input.taxContext.customerGstin,
      });
    } catch (e) {
      console.warn("[fare] tax split failed, keeping flat GST:", (e as Error).message);
    }
  }

  // Calculate discounts
  const promoDiscount = input.promoDiscount || 0;
  const coinDiscount = input.coinDiscount || 0;
  const totalDiscount = promoDiscount + coinDiscount;

  // Calculate final fare
  const finalFare = Math.max(0, totalWithGst - totalDiscount);

  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceCharge: Math.round(distanceCharge * 100) / 100,
    timeCharge: Math.round(timeCharge * 100) / 100,
    surgeCharge: Math.round(surgeCharge * 100) / 100,
    surgeMultiplier,
    surgeLabel: surge.label,
    addonCharges: Math.round(addonCharges * 100) / 100,
    stopCharges: Math.round(stopCharges * 100) / 100,
    loadingUnloadingCharge: Math.round(loadingUnloadingCharge * 100) / 100,
    waitingCharge: 0, // Calculated after trip
    tollCharges: Math.round(tollCharges * 100) / 100,
    subtotal: Math.round(subtotal * 100) / 100,
    gstAmount: Math.round(gstAmount * 100) / 100,
    gstPercentage,
    promoDiscount: Math.round(promoDiscount * 100) / 100,
    coinDiscount: Math.round(coinDiscount * 100) / 100,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    finalFare: Math.round(finalFare * 100) / 100,
    // Same source of truth calculateWaitingCharges bills from, so what the
    // customer is quoted is exactly what they'll be charged.
    freeWaitingMinutes: rates.freeWaitingMinutes,
    waitingChargePerMin: fareConfig?.waitingChargePerMin ?? 2,
    rateSource: rates.rateSource,
    rateCity: rates.rateCity,
    taxBreakdown,
  };
};

/**
 * Calculate waiting charges after trip. Free minutes come from the vehicle
 * type's rate card (city-aware) when the trip is known; the global figure
 * otherwise.
 */
export const calculateWaitingCharges = async (
  waitingMinutes: number,
  context?: { vehicleTypeId?: Types.ObjectId | string | null; city?: string | null },
): Promise<number> => {
  const fareConfig = await FareConfig.findOne({ isActive: true });
  let freeWaitingMinutes = fareConfig?.freeWaitingMinutes || 10;
  // Waiting beyond the free minutes is billed at the vehicle type's own
  // per-minute rate (city rate card aware) — the same figure the customer is
  // quoted for trip time. The global waitingChargePerMin is only the fallback
  // for a booking with no vehicle type, and is no longer an admin-facing field.
  let waitingChargePerMin = fareConfig?.waitingChargePerMin || 2;

  if (context?.vehicleTypeId) {
    const vt = await VehicleType.findById(context.vehicleTypeId).lean();
    if (vt) {
      const rates = resolveRates(vt, fareConfig, context.city);
      freeWaitingMinutes = rates.freeWaitingMinutes;
      if (rates.perMinuteRate > 0) waitingChargePerMin = rates.perMinuteRate;
    }
  }

  const chargeableMinutes = Math.max(0, waitingMinutes - freeWaitingMinutes);
  return Math.round(chargeableMinutes * waitingChargePerMin * 100) / 100;
};

/**
 * Recalculate fare after trip completion
 */
export const recalculateFareAfterTrip = async (
  originalFare: FareBreakdown,
  actualDistanceKm: number,
  actualDurationMin: number,
  waitingMinutes: number,
  additionalTolls: number = 0,
  context?: { vehicleTypeId?: Types.ObjectId | string | null; city?: string | null },
): Promise<FareBreakdown> => {
  const waitingCharge = await calculateWaitingCharges(waitingMinutes, context);

  // For now, keep the original fare but add waiting and toll charges
  // In production, you might recalculate based on actual distance
  const newSubtotal = originalFare.subtotal + waitingCharge + additionalTolls;
  const gstAmount = (newSubtotal * originalFare.gstPercentage) / 100;
  const totalWithGst = newSubtotal + gstAmount;
  const finalFare = Math.max(0, totalWithGst - originalFare.totalDiscount);

  return {
    ...originalFare,
    waitingCharge,
    tollCharges: originalFare.tollCharges + additionalTolls,
    subtotal: Math.round(newSubtotal * 100) / 100,
    gstAmount: Math.round(gstAmount * 100) / 100,
    finalFare: Math.round(finalFare * 100) / 100,
  };
};

/**
 * Get fare estimate for display
 */
export const getFareEstimate = async (
  vehicleTypeId: Types.ObjectId,
  distanceKm: number,
  durationMin: number,
  serviceType: "WITHIN_CITY" | "OUTSTATION" = "WITHIN_CITY",
  city?: string | null,
) => {
  const fare = await calculateFare({
    vehicleTypeId,
    distanceKm,
    durationMin,
    serviceType,
    city,
  });

  // Add 10% buffer for estimate range
  const minFare = Math.round(fare.finalFare * 0.9);
  const maxFare = Math.round(fare.finalFare * 1.1);

  return {
    estimatedFare: fare.finalFare,
    fareRange: { min: minFare, max: maxFare },
    breakdown: fare,
  };
};

/**
 * The commission percentage a completed trip settles at: the vehicle type's
 * own figure (city-aware) when set, otherwise the global FareConfig value.
 * Used at completion so the driver's frozen earnings follow the same card
 * that priced the trip.
 */
export const commissionPercentFor = async (
  vehicleTypeId: Types.ObjectId | string | null | undefined,
  city?: string | null,
): Promise<number> => {
  const fareConfig = await FareConfig.findOne({ isActive: true }).lean();
  if (!vehicleTypeId) {
    return Number((fareConfig as any)?.driverCommissionPercent ?? 20);
  }
  const vt = await VehicleType.findById(vehicleTypeId).lean();
  return resolveRates(vt, fareConfig, city).commissionPercent;
};
