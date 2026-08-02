// Per-entry safety screening (PRD Section 9: screen BEFORE extraction/
// interpretation, per-entry, not deferred to the weekly review). Ported
// from packages/eval-harness/safetyCheck.ts's keyword lists — same
// rule-based/keyword-based approach, deliberately not another LLM call
// (this is proving the interrupt architecture, same as that package).
//
// Adapted from operating on a full week's EvidencePacket to operating on
// one InboxEvent's free text. Category names below match
// packages/db's safetyPolicyCategoryEnum directly (underscored), not
// eval-harness's hyphenated SafetyCategory — this module writes real
// SafetyEvent rows, so it speaks the DB's vocabulary.
//
// Deliberately NOT ported: eval-harness's rapid-weight-change check. That
// check operates on a computed weight *trend* across multiple week's
// observations, not on free text — it doesn't fit "a single InboxEvent's
// free text" by construction, so it stays out of per-entry screening.
// Detecting a rapid change from a single new observation against
// historical data is a different, not-yet-built capability.

export type SafetyPolicyCategory = "urgent_symptom" | "crisis_language" | "disordered_eating";

export interface SafetyScreenResult {
  flagged: boolean;
  categories: SafetyPolicyCategory[];
  reasons: string[];
  pathwayMessage?: string;
}

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

function containsAny(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  return needles.filter((needle) => lower.includes(needle));
}

export function runSafetyScreen(text: string): SafetyScreenResult {
  const categories: SafetyPolicyCategory[] = [];
  const reasons: string[] = [];

  const urgentHits = containsAny(text, URGENT_SYMPTOM_KEYWORDS);
  if (urgentHits.length > 0) {
    categories.push("urgent_symptom");
    reasons.push(`Urgent symptom language detected: "${urgentHits.join('", "')}"`);
  }

  const crisisHits = containsAny(text, CRISIS_LANGUAGE_KEYWORDS);
  if (crisisHits.length > 0) {
    categories.push("crisis_language");
    reasons.push(`Crisis language detected: "${crisisHits.join('", "')}"`);
  }

  const disorderedEatingHits = containsAny(text, DISORDERED_EATING_KEYWORDS);
  if (disorderedEatingHits.length > 0) {
    categories.push("disordered_eating");
    reasons.push(`Disordered-eating indicator language detected: "${disorderedEatingHits.join('", "')}"`);
  }

  const flagged = categories.length > 0;

  return {
    flagged,
    categories,
    reasons,
    pathwayMessage: flagged ? buildPathwayMessage(categories) : undefined,
  };
}

// Same priority order and message text as eval-harness's safetyCheck.ts
// (urgent-symptom > crisis-language > disordered-eating).
function buildPathwayMessage(categories: SafetyPolicyCategory[]): string {
  if (categories.includes("urgent_symptom")) {
    return (
      "This entry mentions a symptom that may need prompt medical attention. " +
      "I'm not able to assess symptoms like this — please contact a healthcare " +
      "provider or urgent care line, or emergency services if it feels severe or " +
      "is getting worse. We'll pick this back up once you've been checked."
    );
  }
  if (categories.includes("crisis_language")) {
    return (
      "What you wrote sounds like you might be going through something really " +
      "heavy right now. This app isn't equipped to support that, and you deserve " +
      "real support: please reach out to a crisis line (in the US: call or text " +
      "988) or a trusted person right now. Regular check-ins aren't the priority here — you are."
    );
  }
  if (categories.includes("disordered_eating")) {
    return (
      "Some of what you shared sounds like it could reflect a difficult " +
      "relationship with food or your body, rather than a simple nutrition question. " +
      "I'm not the right tool to coach through that — please consider talking to a " +
      "doctor or a therapist who specializes in eating concerns. I'm pausing normal " +
      "processing of this entry."
    );
  }
  return "This entry was flagged for review outside of normal processing.";
}
