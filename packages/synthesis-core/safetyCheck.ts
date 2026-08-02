// Rule-based safety interrupt. Deliberately simple and keyword/threshold
// driven — this is proving the "flag before synthesis" architecture, not
// the real clinical detector, which will replace this in a later package.
//
// Moved here unmodified from packages/eval-harness in Package 9, shared
// with packages/api's weekly-level safety gate. This is a genuinely
// different, additional check from packages/api's per-entry safetyScreen.ts
// (Package 5/8): per-entry catches things as they're logged; this evaluates
// a whole week's evidence packet at once, so it can catch patterns (like a
// gradual multi-entry crisis pattern, or a week-over-week weight swing) that
// no single entry's screening would trigger.

import { EvidencePacket, SafetyCategory, SafetyCheckResult } from "./types";

const URGENT_SYMPTOM_KEYWORDS = [
  "chest pain",
  "chest tightness",
  "can't breathe",
  "cant breathe",
  "shortness of breath",
  "difficulty breathing",
  "fainted",
  "fainting",
  "passed out",
  "severe pain",
  "blood in my stool",
  "blood in stool",
  "coughing up blood",
  "vomiting blood",
  "irregular heartbeat",
  "heart racing uncontrollably",
  "numbness in my arm",
  "numbness down my",
];

const CRISIS_LANGUAGE_KEYWORDS = [
  "kill myself",
  "want to die",
  "wish i wasn't here",
  "wish i weren't here",
  "don't want to be here anymore",
  "no reason to live",
  "no point in going on",
  "no point in any of this",
  "ending it all",
  "ending it",
  "hurting myself",
  "hurt myself",
  "self-harm",
  "self harm",
  "not worth living",
  "better off without me",
];

const DISORDERED_EATING_KEYWORDS = [
  "purge",
  "purging",
  "made myself throw up",
  "throw up on purpose",
  "laxative",
  "binge",
  "binged",
  "don't deserve to eat",
  "dont deserve to eat",
  "punish myself with food",
  "punish myself by not eating",
  "starve myself",
  "starving myself",
  "hate my body",
  "disgusting",
  "compensate by not eating",
  "make up for it by not eating",
];

/** Fraction of starting body weight lost/gained in a single week that triggers review. */
const RAPID_WEIGHT_CHANGE_FRACTION = 0.02;

function containsAny(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  return needles.filter((needle) => lower.includes(needle));
}

function collectFreeText(packet: EvidencePacket): string {
  const parts: string[] = [packet.weeklyReflection.reflectionText];
  for (const obs of packet.observations) {
    if (obs.freeTextNotes) parts.push(obs.freeTextNotes);
    if (obs.symptoms) parts.push(obs.symptoms.join(". "));
  }
  return parts.join("\n");
}

function checkRapidWeightChange(packet: EvidencePacket): { flagged: boolean; reason?: string } {
  const trend = packet.derivedMetrics.weightTrend;
  if (!trend) return { flagged: false };

  const startingWeightValue = packet.baseline.startingWeight.value;
  if (!startingWeightValue) return { flagged: false };

  const fractionChanged = Math.abs(trend.deltaValue) / startingWeightValue;
  if (fractionChanged >= RAPID_WEIGHT_CHANGE_FRACTION) {
    return {
      flagged: true,
      reason: `Weight changed by ${trend.deltaValue.toFixed(1)} ${trend.unit} this week (${(
        fractionChanged * 100
      ).toFixed(1)}% of starting weight), at or above the ${(
        RAPID_WEIGHT_CHANGE_FRACTION * 100
      ).toFixed(0)}% rapid-change threshold.`,
    };
  }
  return { flagged: false };
}

export function runSafetyCheck(packet: EvidencePacket): SafetyCheckResult {
  const freeText = collectFreeText(packet);
  const categories: SafetyCategory[] = [];
  const reasons: string[] = [];

  const urgentHits = containsAny(freeText, URGENT_SYMPTOM_KEYWORDS);
  if (urgentHits.length > 0) {
    categories.push("urgent-symptom");
    reasons.push(`Urgent symptom language detected: "${urgentHits.join('", "')}"`);
  }

  const crisisHits = containsAny(freeText, CRISIS_LANGUAGE_KEYWORDS);
  if (crisisHits.length > 0) {
    categories.push("crisis-language");
    reasons.push(`Crisis language detected: "${crisisHits.join('", "')}"`);
  }

  const disorderedEatingHits = containsAny(freeText, DISORDERED_EATING_KEYWORDS);
  if (disorderedEatingHits.length > 0) {
    categories.push("disordered-eating");
    reasons.push(`Disordered-eating indicator language detected: "${disorderedEatingHits.join('", "')}"`);
  }

  const rapidChange = checkRapidWeightChange(packet);
  if (rapidChange.flagged) {
    categories.push("rapid-weight-change");
    reasons.push(rapidChange.reason!);
  }

  const flagged = categories.length > 0;

  return {
    flagged,
    categories,
    reasons,
    pathwayMessage: flagged ? buildPathwayMessage(categories) : undefined,
  };
}

function buildPathwayMessage(categories: SafetyCategory[]): string {
  if (categories.includes("urgent-symptom")) {
    return (
      "This entry mentions a symptom that may need prompt medical attention. " +
      "I'm not able to assess symptoms like this — please contact a healthcare " +
      "provider or urgent care line, or emergency services if it feels severe or " +
      "is getting worse. We'll pick weekly coaching back up once you've been checked."
    );
  }
  if (categories.includes("crisis-language")) {
    return (
      "What you wrote sounds like you might be going through something really " +
      "heavy right now. This app isn't equipped to support that, and you deserve " +
      "real support: please reach out to a crisis line (in the US: call or text " +
      "988) or a trusted person right now. Weekly coaching isn't the priority here — you are."
    );
  }
  if (categories.includes("disordered-eating")) {
    return (
      "Some of what you shared this week sounds like it could reflect a difficult " +
      "relationship with food or your body, rather than a simple nutrition question. " +
      "I'm not the right tool to coach through that — please consider talking to a " +
      "doctor or a therapist who specializes in eating concerns. I'm pausing regular " +
      "coaching suggestions for this week."
    );
  }
  if (categories.includes("rapid-weight-change")) {
    return (
      "Your weight changed unusually quickly this week. That's worth a conversation " +
      "with a healthcare provider rather than a coaching suggestion from this app, " +
      "since rapid changes can have causes an app can't evaluate. I'm holding off on " +
      "a normal weekly review until that's been looked at."
    );
  }
  return "This week's entry was flagged for review outside of normal coaching.";
}
