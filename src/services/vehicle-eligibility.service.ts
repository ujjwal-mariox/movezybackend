/** Booking eligibility is separate from ranking and from historical trip billing. */
export const vehicleIneligibility = (type: any, distanceKm: number, serviceType = "WITHIN_CITY") => {
  if (!type || type.isActive === false || type.isDeleted === true) return "VEHICLE_UNAVAILABLE";
  if (serviceType === "OUTSTATION" && type.categoryCode === "2W") return "OUTSTATION_TWO_WHEELER";
  if (Number(type.maxRangeKm) > 0 && distanceKm > Number(type.maxRangeKm)) return "DISTANCE_LIMIT";
  return null;
};

export const validRoutePoint = (point: any): boolean =>
  point?.lat != null && point?.lng != null &&
  point.lat !== "" && point.lng !== "" &&
  Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)) &&
  Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lng)) <= 180 &&
  !(Number(point.lat) === 0 && Number(point.lng) === 0);

export const vehicleEligibilityMessage = (code: string, type?: any, distanceKm?: number): string => {
  if (code === "OUTSTATION_TWO_WHEELER") return "Two-wheelers are available only for Within City trips. Choose a larger vehicle for Outstation, or change your locations.";
  if (code === "DISTANCE_LIMIT" && type) return `This trip is ${Number(distanceKm).toFixed(1)} km including stops. ${type.name} can cover up to ${Number(type.maxRangeKm).toFixed(1)} km. Change your locations or choose another vehicle.`;
  if (code === "DISTANCE_LIMIT") return `No vehicle can cover this ${Number(distanceKm).toFixed(1)} km trip within its configured distance limit. Change your locations or remove a detour.`;
  if (code === "NO_ACTIVE_VEHICLES") return "Booking vehicles are temporarily unavailable. Please try again later.";
  if (code === "OUTSTATION_UNAVAILABLE") return "No Outstation vehicles are available for these locations. Change your locations or check again later.";
  if (code === "PRICE_UNAVAILABLE" || code === "PRICES_UNAVAILABLE") return "Prices are temporarily unavailable for this vehicle. Choose another vehicle or try again.";
  return "Your selected vehicle is no longer available. Choose another vehicle or check again later.";
};
