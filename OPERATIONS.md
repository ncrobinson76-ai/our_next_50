# Operations

Process decisions that need to be tracked, not just remembered. This file
is not code — it exists so a constraint like the one below survives past
whoever was in the room when it was made.

## Rollout gate on real users (as of Package 9, 2026-08-02)

Real synthesis output now reaches actual users as of Package 9. Per a
documented decision on 2026-08-02, onboarding any user beyond the founder
testing solo is gated on two pending external reviews:

1. A clinical safety review of the safety-pathway logic and detection
   categories.
2. An attorney review of Terms of Service / liability language covering
   crisis and disordered-eating content.

**Do not remove this gate without an explicit decision to do so.**

### What "real synthesis output" means

Starting with Package 9, `packages/api`'s
`POST /api/program-weeks/current/generate-review` assembles a real user's
own logged data into an `EvidencePacket` and, if the weekly-level safety
gate doesn't flag it, sends that data to an LLM (via
`packages/synthesis-core`) and persists and returns the model's structured
output as a `WeeklyReview`. Before Package 9, every LLM-generated synthesis
in this repo ran only against fictional scenario data
(`packages/eval-harness`, Package 0). This is the line between "a prototype
being evaluated" and "a system a real person could read output from."

### What's covered by each pending review

- **Clinical safety review**: the keyword/threshold safety screens
  (`packages/api/src/inbox/safetyScreen.ts` for per-entry screening,
  `packages/synthesis-core/safetyCheck.ts` for the weekly-level gate) and
  the six detection categories they cover (`urgent_symptom`,
  `crisis_language`, `disordered_eating`, `rapid_weight_change`,
  `pregnancy_related`, `extreme_restriction`). See
  `packages/api/README.md`'s "Known limitations, for clinical/legal review"
  subsection for the full, deliberately unreassuring self-assessment of
  what these screens can and cannot catch.
- **Attorney review**: Terms of Service / liability language covering what
  happens when a user's entry gets flagged by a crisis-language or
  disordered-eating pathway, and more generally what a user is told (or
  not told) about the limits of an AI-generated weekly review giving
  health-adjacent guidance.

### Status

Both reviews are pending. No user beyond founder solo testing should be
onboarded until both are complete and this section is updated to reflect
that.
