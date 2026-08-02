// ACC-03: consent capture. Bump this whenever the consent scope changes —
// any user whose stored users.consentVersion doesn't match gets blocked
// from every other route until they re-accept.
export const CURRENT_CONSENT_VERSION = "2026-08-01.v1";

export interface ConsentDocument {
  version: string;
  wellnessScope: string;
  aiProcessing: string;
  audioHandling: string;
}

export function getCurrentConsentDocument(): ConsentDocument {
  return {
    version: CURRENT_CONSENT_VERSION,
    wellnessScope:
      "We collect wellness data you choose to share (weight, sleep, meals, activity, and similar) to help you track and reflect on your own progress. This is not medical advice or treatment.",
    aiProcessing:
      "Your logged data and messages may be processed by AI models to generate weekly syntheses, summaries, and suggestions. AI-generated content can be wrong and should not be treated as clinical guidance.",
    audioHandling:
      "If you send voice messages, audio is transcribed to text for processing. Raw audio is retained only as long as needed for that processing and is subject to deletion per our retention policy.",
  };
}
