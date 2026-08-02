// Re-exports packages/synthesis-core's shared weekly-synthesis engine and
// types via a relative import, same convention as this package's db.ts for
// packages/db — a plain sibling-package relative import, no npm workspace,
// since there's no build/publish step between these packages either. Every
// other file in this package should import from "./synthesisCore", not
// reach into packages/synthesis-core directly, so this stays the single
// place that relative path lives.
export * from "../../synthesis-core/types";
export { synthesizeFromPacket } from "../../synthesis-core/synthesisEngine";
export { runSafetyCheck } from "../../synthesis-core/safetyCheck";
export {
  computeAverageHungerLevel,
  computeAverageSleepHours,
  computeWeightTrend,
  daysBetweenInclusive,
} from "../../synthesis-core/derivedMetrics";
