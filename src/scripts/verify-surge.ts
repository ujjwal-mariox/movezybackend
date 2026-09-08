import { surgeAt, activeWeatherSurges } from "../services/fare.service";

/**
 * Pure verification of surge selection (no database): peak/night windows and
 * region-based weather surges, highest multiplier wins, never compounding.
 * Run: npx ts-node src/scripts/verify-surge.ts
 */
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " → " + JSON.stringify(detail) : ""}`);
  if (!ok) process.exitCode = 1;
};

const at = (hour: number) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
};
const inOneHour = () => new Date(Date.now() + 3600 * 1000);
const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000);

const cfg = {
  peakWindows: [{ label: "Morning", startHour: 8, endHour: 10, multiplier: 1.5 }],
  nightWindows: [{ label: "Night", startHour: 22, endHour: 6, multiplier: 1.4 }],
  weatherSurges: [
    { label: "Rain — Mumbai", cities: ["Mumbai"], multiplier: 1.3, isActive: true, activeUntil: inOneHour() },
    { label: "Storm — all", cities: [], multiplier: 1.8, isActive: false, activeUntil: null },
    { label: "Old rain", cities: ["Pune"], multiplier: 2, isActive: true, activeUntil: new Date(Date.now() - 1000) },
  ],
};

const now = new Date();
const quiet = new Date(now);
quiet.setHours(14, 0, 0, 0); // outside peak and night

check("no surge mid-afternoon in a dry city", surgeAt(cfg, quiet, "Pune").multiplier === 1);
check("rain applies in Mumbai (matching city)", surgeAt(cfg, quiet, "Mumbai").multiplier === 1.3, surgeAt(cfg, quiet, "Mumbai"));
check("rain applies to 'Mumbai Suburban' (containment match)", surgeAt(cfg, quiet, "Mumbai Suburban").multiplier === 1.3);
check("expired auto-off surge is ignored", surgeAt(cfg, quiet, "Pune").multiplier === 1);
check("switched-off surge is ignored", activeWeatherSurges(cfg, "Delhi", quiet).length === 0);
check("no city → city-scoped rain does not apply", surgeAt(cfg, quiet, null).multiplier === 1);
check("peak 1.5 beats rain 1.3 (no compounding)", surgeAt(cfg, at(9), "Mumbai").multiplier === 1.5, surgeAt(cfg, at(9), "Mumbai"));

const stormOn = { ...cfg, weatherSurges: [{ label: "Storm — all", cities: [], multiplier: 1.8, isActive: true, activeUntil: null }] };
check("storm 1.8 everywhere beats peak 1.5", surgeAt(stormOn, at(9), "Pune").multiplier === 1.8 && surgeAt(stormOn, at(9), "Pune").label === "Storm — all");
check("weather does not apply to a pickup scheduled tomorrow", activeWeatherSurges(stormOn, "Pune", tomorrow()).length === 0);
check("night window wraps midnight (23:00)", surgeAt(cfg, at(23), "Pune").multiplier === 1.4);
