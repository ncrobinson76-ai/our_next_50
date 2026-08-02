import type { ScopedDataAccess } from "../data/scopedDataAccess";

// Per-entry safety screening (PRD Section 9: screen BEFORE extraction/
// interpretation, per-entry, not deferred to the weekly review). Started
// (Package 5) as a direct port of packages/eval-harness/safetyCheck.ts's
// keyword lists — same rule-based/keyword-based approach, deliberately not
// another LLM call (this is proving the interrupt architecture, same as
// that package). Package 8 hardens this per PRD Section 10's multi-layer
// design: deeper keyword coverage on the original three categories, two
// new categories (pregnancy_related, extreme_restriction), and the
// rapid-weight-change gap explicitly left open since Package 6 is now
// closed (see checkRapidWeightChange below). Category names match
// packages/db's safetyPolicyCategoryEnum directly (underscored), not
// eval-harness's hyphenated SafetyCategory — this module writes real
// SafetyEvent rows, so it speaks the DB's vocabulary.
//
// Package 8 changes detection logic only. The pipeline's control flow
// (screen-before-extraction, hard short-circuit) from Package 5 is
// untouched — runSafetyScreen() below is called exactly where it always
// was. checkRapidWeightChange() is a second, independent check-and-
// short-circuit point pipeline.ts calls after extraction (it needs the
// candidate weight value extraction produces), using the same
// SafetyEvent + short-circuit pattern, not a restructuring of the first.
//
// See README.md's "Known limitations, for clinical/legal review" section
// — required reading before treating any of this as more than what it is.

export type SafetyPolicyCategory =
  | "urgent_symptom"
  | "crisis_language"
  | "disordered_eating"
  | "rapid_weight_change"
  | "pregnancy_related"
  | "extreme_restriction";

export interface SafetyScreenResult {
  flagged: boolean;
  categories: SafetyPolicyCategory[];
  reasons: string[];
  pathwayMessage?: string;
}

// --- urgent_symptom -----------------------------------------------------
// Original list ported from eval-harness Package 0, exercised by
// eval-harness's single urgent-symptom.json scenario ("chest tightness
// and shortness of breath climbing the stairs"), both phrases already
// covered. Additions below are proactive: eval-harness only has one
// scenario for this category, which doesn't exercise the realistic range
// of how urgent symptoms actually get described. Chosen for being
// recognized red-flag phrasings in general symptom triage, not just
// variations on the one scenario's wording.
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
  // Added (Package 8): fainting-adjacent precursor language not covered
  // by "fainted"/"passed out".
  "dizzy",
  "dizziness",
  "lightheaded",
  "light-headed",
  // Added: distinct from "irregular heartbeat", common self-report phrasing.
  "heart palpitations",
  "palpitations",
  // Added: colloquial variant of "shortness of breath".
  "can't catch my breath",
  "cant catch my breath",
  // Added: "worst headache of my life" is a well-known clinical red-flag
  // phrase (thunderclap headache); "severe headache" catches milder
  // self-reports of the same concern.
  "severe headache",
  "worst headache of my life",
  // Added: dehydration-risk language distinct from "vomiting blood".
  "can't keep anything down",
  "cant keep anything down",
  "can't stop vomiting",
  "cant stop vomiting",
  // Added: possible cardiac/renal red flag relevant to a weight-management population.
  "swelling in my legs",
  "legs are swollen",
  // Added: distinct obstruction/choking risk.
  "difficulty swallowing",
  "trouble swallowing",
];

// --- crisis_language -----------------------------------------------------
// Original list ported from eval-harness Package 0. Cross-checked against
// eval-harness's mental-health-crisis-language.json scenario ("no point in
// any of this anymore", "don't want to be here anymore") — both already
// covered exactly. Additions below are proactive, kept deliberately
// conservative: phrases like "I can't do this anymore" are extremely
// common ordinary frustration in a diet/weight-loss app (said about the
// diet, not about being alive) and were deliberately NOT added despite
// being common crisis-adjacent phrasing elsewhere, because the
// false-positive rate in THIS app's specific domain would be very high.
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
  // Added (Package 8): direct clinical terms — surprisingly, the original
  // list only had euphemisms, not the plain clinical words themselves.
  "suicidal",
  "thoughts of suicide",
  "thinking about suicide",
  "want to end my life",
  "end my life",
  // Added: extremely common self-reported crisis language not captured
  // by "not worth living" / "better off without me".
  "i'm a burden",
  "im a burden",
  // Added: passive suicidal ideation phrasing, clinically significant and
  // distinct from active phrases like "want to die".
  "don't want to wake up",
  "dont want to wake up",
  "wish i could disappear",
  "tired of being alive",
];

// --- disordered_eating -----------------------------------------------------
// Original list ported from eval-harness Package 0. Cross-checked against
// eval-harness's possible-disordered-eating-language.json scenario. Its
// weekly reflection text ("binged", "don't deserve to eat",
// "compensate by not eating") was already fully covered. But that
// scenario's per-day freeTextNotes include "Trying to make up for Tuesday
// still" as its own entry — in the real per-entry pipeline (unlike
// eval-harness's whole-week packet), that sentence would arrive as its
// OWN InboxEvent, separately from the day it mentions "binged"/"don't
// deserve to eat" — and none of the original keywords match it. That's a
// concrete, real gap the per-entry model creates that eval-harness's
// weekly-packet model never surfaces, since eval-harness only ever
// screens the whole week's text at once.
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
  // Added (Package 8): generalizes the existing "make up for it by not
  // eating" / "compensate by not eating" to catch the gap above. Known,
  // accepted false-positive risk — "make up for it" isn't always about
  // food (e.g. "make up for it with my partner") — kept anyway per this
  // package's stated philosophy: false positives here are handled by
  // gentler pathway wording (see buildPathwayMessage), not chased away
  // with narrower-but-fragile phrasing.
  "make up for it",
  "trying to make up for",
  // Added: direct clinical self-report term, absent from the original list.
  "eating disorder",
  // Added: common relapse-language phrasing.
  "restricting again",
  "not allowing myself to eat",
];

// --- pregnancy_related (new, Package 8) -----------------------------------
// PRD Section 10 names this as its own risk category: weight-management
// guidance (restriction, exercise intensity) is not appropriate for
// someone who may be pregnant, and that's a distinct redirect (to
// prenatal/OB care) from any of the other four categories, not a
// disordered_eating or "other" variant. Deliberately scoped to pregnancy/
// trying-to-conceive language only, not breastfeeding/postpartum, to keep
// this addition narrow and match the PRD's exact framing rather than
// quietly expanding scope.
const PREGNANCY_RELATED_KEYWORDS = [
  "i'm pregnant",
  "im pregnant",
  "i think i'm pregnant",
  "i think im pregnant",
  "might be pregnant",
  "just found out i'm pregnant",
  "just found out im pregnant",
  "trying to get pregnant",
  "trying to conceive",
  "i'm expecting",
  "im expecting",
  "having a baby",
  "missed my period",
  "positive pregnancy test",
  "took a pregnancy test",
];

// --- extreme_restriction (new, Package 8) ---------------------------------
// PRD Section 10's second uncovered category: compulsive/rule-bound
// exercise or caloric restriction, framed as compulsion rather than
// eating-disorder-specific language — kept deliberately distinct from
// disordered_eating's body-image/food-behavior framing above.
//
// Calibration note: eval-harness's very-high-hunger-unwise-to-restrict.json
// scenario — someone training hard for a 5K, considering "cutting my
// portions down" / "cutting portions further" because hunger is intense —
// is explicitly a scenario that should NOT be safety-flagged (the correct
// response is restraint-oriented normal coaching, not a safety
// short-circuit). None of the phrases below match that scenario's text;
// ordinary portion-control language and dedicated athletic training are
// deliberately not in scope here. The bar is genuinely compulsive/rigid
// framing, not high effort or normal calorie-consciousness.
const EXTREME_RESTRICTION_KEYWORDS = [
  "eating under 500 calories",
  "eating under 800 calories",
  "barely eating anything for days",
  "haven't eaten in days",
  "havent eaten in days",
  "not eaten in days",
  "fasting for days",
  "only eating once a day for weeks",
  "exercise no matter what",
  "have to work out every single day",
  "can't skip a workout",
  "cant skip a workout",
  "exercise even when injured",
  "work out even when sick",
  "burn off everything i eat",
  "punish myself with exercise",
  "extra workout to make up for",
  "obsessed with burning calories",
  "panic if i miss a workout",
  "can't rest without feeling guilty",
  "cant rest without feeling guilty",
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

  const pregnancyHits = containsAny(text, PREGNANCY_RELATED_KEYWORDS);
  if (pregnancyHits.length > 0) {
    categories.push("pregnancy_related");
    reasons.push(`Pregnancy-related language detected: "${pregnancyHits.join('", "')}"`);
  }

  const disorderedEatingHits = containsAny(text, DISORDERED_EATING_KEYWORDS);
  if (disorderedEatingHits.length > 0) {
    categories.push("disordered_eating");
    reasons.push(`Disordered-eating indicator language detected: "${disorderedEatingHits.join('", "')}"`);
  }

  const extremeRestrictionHits = containsAny(text, EXTREME_RESTRICTION_KEYWORDS);
  if (extremeRestrictionHits.length > 0) {
    categories.push("extreme_restriction");
    reasons.push(`Extreme restriction/over-exercise language detected: "${extremeRestrictionHits.join('", "')}"`);
  }

  const flagged = categories.length > 0;

  return {
    flagged,
    categories,
    reasons,
    pathwayMessage: flagged ? buildPathwayMessage(categories) : undefined,
  };
}

// Priority order when multiple categories match the same text (rare, but
// possible): urgent_symptom (acute physical risk) > crisis_language
// (acute mental health risk) > pregnancy_related (redirects to a
// different, non-acute-but-important care pathway) > disordered_eating >
// extreme_restriction (a closely related risk cluster; disordered_eating
// takes precedence as the more established category) > rapid_weight_change
// (a numeric signal, least specific about why). In practice
// rapid_weight_change never competes here — it's only ever produced by
// checkRapidWeightChange() below, called from a separate point in the
// pipeline after text screening has already passed.
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
    // Threading a real tension (see README's "Known limitations" section):
    // gentle about the possibility of a false trigger, without leading
    // with that possibility in a way that could undermine a true
    // positive. The serious response comes first and stays unconditional
    // ("if there's any chance that's true"); the false-positive
    // acknowledgment is clearly subordinate and closes by explicitly
    // telling the user not to let it stop them from reaching out.
    return (
      "What you wrote sounds like you might be going through something really " +
      "heavy right now. If there's any chance that's true, please reach out to a " +
      "crisis line (in the US: call or text 988) or a trusted person right now — " +
      "you deserve real support, and this app isn't equipped to provide it. If " +
      "I've misunderstood and that's not what you meant, you can send a " +
      "follow-up describing what you actually meant and we'll pick regular " +
      "check-ins back up from there. But please don't let a possible " +
      "misunderstanding on my part stop you from reaching out if any part of " +
      "this was real."
    );
  }
  if (categories.includes("pregnancy_related")) {
    return (
      "What you shared suggests you might be pregnant or trying to conceive. " +
      "Nutrition and activity needs are different during pregnancy, so " +
      "weight-management guidance isn't appropriate here — this should be " +
      "guided by your OB/GYN or a prenatal care provider, not this app. " +
      "Congratulations if that's welcome news; either way, I'm pausing regular " +
      "coaching for now — please loop in your care team."
    );
  }
  if (categories.includes("disordered_eating")) {
    return (
      "Some of what you shared could reflect a difficult relationship with food " +
      "or your body — or it might just be an unusually worded normal day, and I " +
      "may have over-read it. Either way, I'm not the right tool to sort that " +
      "out: if this does reflect a struggle, please consider talking to a doctor " +
      "or a therapist who specializes in eating concerns — they can help in a " +
      "way I can't. If I've misread this, you can send a follow-up describing " +
      "what actually happened and we'll continue normally from there."
    );
  }
  if (categories.includes("extreme_restriction")) {
    return (
      "What you described sounds like it could reflect eating or exercise " +
      "patterns that are more about rigid rules or compulsion than a sustainable " +
      "plan — sometimes called over-exercising or extreme restriction. That's " +
      "worth a conversation with a doctor or therapist who works with these " +
      "patterns, not something this app should coach through. I'm pausing " +
      "regular suggestions for this entry."
    );
  }
  if (categories.includes("rapid_weight_change")) {
    return (
      "Your weight changed unusually quickly compared to your last logged " +
      "weight. That's worth a conversation with a healthcare provider rather " +
      "than a coaching suggestion from this app, since rapid changes can have " +
      "causes an app can't evaluate. I'm holding off on regular processing of " +
      "this entry until that's been looked at."
    );
  }
  return "This entry was flagged for review outside of normal processing.";
}

// --- rapid_weight_change (closes the Package 6 gap) -----------------------
// Same 2%-of-starting-weight threshold as eval-harness's Package 0
// prototype, adapted from "first vs. last logged weight within a week's
// EvidencePacket" to "a newly proposed weight vs. the user's own most
// recent prior (non-superseded) weight Observation." This is a computed
// comparison, not text matching — it runs from pipeline.ts after
// extraction produces candidate Observations (it needs the actual
// proposed weight value), not from runSafetyScreen() above. See
// README.md's "Known limitations" section for what this check does and
// doesn't account for (population norms, medical causes, etc.).

const RAPID_WEIGHT_CHANGE_FRACTION = 0.02;
const KG_TO_LB = 2.20462;

function toPounds(value: number, unit: string): number {
  return unit === "kg" ? value * KG_TO_LB : value;
}

export interface RapidWeightChangeCandidate {
  value?: number;
  unit?: string;
}

export interface RapidWeightChangeCheckResult {
  flagged: boolean;
  reason?: string;
  pathwayMessage?: string;
}

export async function checkRapidWeightChange(
  data: ScopedDataAccess,
  candidates: RapidWeightChangeCandidate[]
): Promise<RapidWeightChangeCheckResult> {
  const weightCandidates = candidates.filter(
    (c): c is Required<RapidWeightChangeCandidate> => typeof c.value === "number" && typeof c.unit === "string"
  );
  if (weightCandidates.length === 0) return { flagged: false };

  const profiles = await data.participantProfiles.list();
  if (profiles.length === 0) return { flagged: false }; // no baseline to compare against

  const profile = profiles.reduce((max, p) => (p.version > max.version ? p : max));
  const startingWeightLb = toPounds(Number(profile.startingWeightValue), profile.startingWeightUnit);
  if (!startingWeightLb) return { flagged: false };

  const priorObservations = await data.observations.list();
  const priorWeights = priorObservations
    .filter((o) => o.type === "weight" && !o.isSuperseded && o.value !== null)
    .sort((a, b) => {
      if (a.observedDate !== b.observedDate) return a.observedDate < b.observedDate ? 1 : -1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  if (priorWeights.length === 0) return { flagged: false }; // nothing to compare a first-ever entry against

  const mostRecentPrior = priorWeights[0];
  const mostRecentPriorLb = toPounds(Number(mostRecentPrior.value), mostRecentPrior.unit ?? "lb");

  for (const candidate of weightCandidates) {
    const candidateLb = toPounds(candidate.value, candidate.unit);
    const deltaLb = candidateLb - mostRecentPriorLb;
    const fraction = Math.abs(deltaLb) / startingWeightLb;
    if (fraction >= RAPID_WEIGHT_CHANGE_FRACTION) {
      const reason =
        `Weight changed by ${deltaLb.toFixed(1)} lb since the last logged weight ` +
        `(${(fraction * 100).toFixed(1)}% of starting weight), at or above the ` +
        `${(RAPID_WEIGHT_CHANGE_FRACTION * 100).toFixed(0)}% rapid-change threshold.`;
      return { flagged: true, reason, pathwayMessage: buildPathwayMessage(["rapid_weight_change"]) };
    }
  }

  return { flagged: false };
}
