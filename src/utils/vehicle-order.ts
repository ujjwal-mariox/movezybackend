/**
 * One order for vehicle types everywhere: the home cards, the customer's
 * vehicle list, the partner app's vehicle form and the admin (client
 * decision, 2026-11-04). Categories go by size, 2 Wheeler → 3 Wheeler →
 * 4 Wheeler → Heavy Vehicle; within a category, vehicles go smallest to
 * largest by load capacity, then cargo length. Types with no category go last.
 */
export const CATEGORY_ORDER = ["2W", "3W", "4W", "HV"] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  "2W": "2 Wheeler",
  "3W": "3 Wheeler",
  "4W": "4 Wheeler",
  HV: "Heavy Vehicle",
};

const rank = (t: any): number => {
  const i = CATEGORY_ORDER.indexOf(t?.categoryCode);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

export const compareVehicleTypes = (a: any, b: any): number =>
  rank(a) - rank(b) ||
  (Number(a?.maxWeightKg) || 0) - (Number(b?.maxWeightKg) || 0) ||
  (Number(a?.lengthFt) || 0) - (Number(b?.lengthFt) || 0) ||
  String(a?.name ?? "").localeCompare(String(b?.name ?? ""));

export const sortVehicleTypes = <T>(types: T[]): T[] => [...types].sort(compareVehicleTypes);

/** The categories that have at least one of these types, in order. */
export const categoriesOf = (types: any[]): { code: string; name: string }[] =>
  CATEGORY_ORDER.filter((code) => types.some((t) => t?.categoryCode === code)).map((code) => ({
    code,
    name: CATEGORY_LABELS[code],
  }));
