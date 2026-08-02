# Phase 1 Status — "Our Next 50"

Prepared at the close of Package 12 (the final package of a 12-package build
sequence), for Nate and the product/engineering reviewer to read before
deciding whether to authorize the four-week founding experiment (PRD
Section 15, item 12).

**This document is written to be read literally, not to reassure.** Where
something isn't done, it says so. Where evidence is indirect or a claim
can't be fully verified from this repository, it says that too.

## The single most important caveat, stated first

**There is no frontend, no mobile browser client, and no UI of any kind in
this repository.** All twelve packages built a REST API (`packages/api`)
plus its supporting libraries (`packages/db`, `packages/synthesis-core`)
and a fictional-scenario evaluation harness (`packages/eval-harness`).
Every one of the 92 automated tests plus the two new Package 12
integration tests drive the system through raw HTTP calls against that
API, not through a browser. Section 15's items about what "a participant
can" do (submit from a mobile browser, inspect a timeline, act on an
experiment) are evidenced here at the API level only — the API supports
all of it, correctly and thoroughly tested, but nobody has clicked a
button in an actual mobile browser against this system. Building that
client is not part of this repository's scope as instructed across all 12
packages, and its absence should weigh heavily on any launch decision.

## Section 15 definition-of-done, item by item

| # | Item | Evidence | Notes |
|---|------|----------|-------|
| 1 | Secure account + informed onboarding | `test/goldenPath.test.ts` — "golden path..." exercises real login (`resolveAppUser` creates the account row on first authenticated request, not a test shortcut), `GET /api/consent` showing `accepted:false` pre-consent, real `POST /api/consent/accept`, then `POST /api/participant-profiles` onboarding (201). `test/isolation.test.ts` — "unauthenticated request to a protected route is rejected", "consent gate blocks other routes until the current version is accepted". | "Secure" = session-based auth via Replit OIDC in production; the OIDC handshake itself can only be verified by an actual login on Replit (documented limitation since Package 2 — no automated test can script a human clicking "Allow" on replit.com). |
| 2 | Submit via voice memo, typed update, or one-minute form, from a mobile browser | `test/goldenPath.test.ts` golden path submits all three in one session. `test/inbox.test.ts` — "text submission creates a text-channel event with the correct payload", "form submission creates a form-channel event with the correct payload", "structural symmetry: text and form events share the exact same top-level field set". `test/voice.test.ts` — "voice parity: a mocked-transcript upload flows through the exact same pipeline as equivalent text". | "From a mobile browser" is unverified — see the caveat above. Voice tests use mocked transcription (Deepgram is a paid, non-deterministic external call); a real Deepgram call is exercised in production, not in CI. |
| 3 | Transcribe/structure input, identify uncertainty, safety first, confirm/correct | See Part C citations below. | — |
| 4 | Inspect/edit a daily timeline distinguishing missing from negative | See Part C citations below. | — |
| 5 | One evidence-aware weekly review separating facts/observations/hypotheses/unknowns/unchanged | `test/goldenPath.test.ts` golden path asserts all five `structuredClaims` sections are present and that a fabricated, never-confirmed value is never stated as unqualified fact (verified via a real Anthropic call, not just the deterministic unit test). `test/weeklyReview.test.ts` — "a real confirmed week produces a well-formed WeeklyReview matching the SynthesisOutput shape", "confirmed observations populate structured fields; unconfirmed ones never do, but surface hedged in freeTextNotes". `packages/eval-harness/rubric.md` dimensions 1 (Factuality) and 2 (Uncertainty) define this separation at the prompt-design level, scored against 16 fictional scenarios. | The rubric scoring is a **manual, human-in-the-loop step by design** (`packages/eval-harness/README.md`: "This package does not auto-score — that's intentionally left for a later package"). **Completed**: `packages/eval-harness/scorecard/SCORECARD.md` records the product owner's actual scores against a fresh, committed 16-scenario run (`packages/eval-harness/scorecard/run-2026-08-02/`) — 16/16 scored, 14/16 clean. Two findings were recorded as known, tracked limitations, not blocking issues: a prompt-calibration gap on a deterministic unit conversion (`unit-date-ambiguity`'s Uncertainty dimension), and confirmed run-to-run divergence between multiple individually-reasonable answers on two genuinely ambiguous scenarios (`apparent-plateau`, `modest-progress-inconsistent-logging`) — see `SCORECARD.md`'s Findings section for detail. |
| 6 | Recommends one manageable experiment, or explicitly recommends maintaining/gathering info, with reasoning | `test/goldenPath.test.ts` golden path asserts `proposedNextStep.type` is one of the three valid values with a non-empty explanation, and (in the run recorded during this package's own verification) a real experiment was proposed and its `rationale` traced to real evidence. `test/weeklyReview.test.ts` — "an insufficient-evidence week produces an honest insufficient-evidence output, not a fabricated one". | `Experiment.target`/`Experiment.difficulty` are always `null` — the underlying prompt (unmodified since Package 0) has no structured field for either, only prose. See "Known limitations" below. |
| 7 | Accept, modify, decline, pause, complete, and evaluate the experiment | `test/goldenPath.test.ts` exercises accept + log-completion against a real, LLM-proposed experiment. `test/experiment.test.ts` covers the full lifecycle exhaustively: accept, modify, decline, pause, retire (this system's name for "complete"), every illegal transition rejected with a 409 (accept-after-decline, retire-after-retire, modify-after-accept, pause-after-pause, pause-on-proposed), and completion logging gated to accepted/modified only. | This system has no route literally named "evaluate." The closest equivalent is `priorExperiment` wiring (`weeklyReview/priorExperiment.ts`) — a prior experiment's outcome is folded into the *next* week's synthesis automatically, which is an implicit, systemic form of evaluation rather than a discrete user-facing "evaluate" action. If Section 15 intends a literal evaluate step distinct from this, it does not exist. |
| 8 | Missed days/weeks -> neutral recovery, no fabricated continuity | `test/goldenPath.test.ts` — "multi-week gap: a 3+ week absence produces an honest, neutral recovery — never fabricated continuity" (real HTTP + real LLM call, asserting `insufficient-evidence`, not fabricated progress). `test/experiment.test.ts` — "a user who skips 2+ weeks gets honest missed ProgramWeek records, not a silent jump to 'current week'", "an existing past ProgramWeek stuck at 'scheduled' is corrected to 'skipped' on a later sync, not left inaccurate". | Both of the load-bearing mechanisms here (missed-week backfill, weekly safety gate) have a "prove it would fail without the guard" demonstration recorded in `packages/api/README.md` — the tests were shown to actually fail when the guard was temporarily disabled, not just assumed to be meaningful. |
| 9 | Safety scenarios interrupt normal coaching with approved guidance; routine AI cannot override it | See Part C citations below. | — |
| 10 | Export data, initiate deletion; cross-account isolation | `test/goldenPath.test.ts` golden path chains Progress -> Privacy -> Export -> two-step deletion -> full-cascade verification in one session. `test/views.test.ts` — export completeness cross-checked against every table, plus cross-account isolation for Progress/Privacy/Export. `test/accountDeletion.test.ts` — two-step confirmation (request without confirm performs no deletion; wrong/expired token rejected), full-cascade test seeding every major table plus a real object-storage file and asserting zero rows remain (except the deliberate SafetyEvent exception, see below), and cross-account isolation (a leaked token cannot be used against another account). Every one of the 13 test files in `packages/api/test/` includes at least one explicit cross-account isolation test; `test/isolation.test.ts` is the general-purpose proof. | — |
| 11 | AI scenario suite and security/privacy acceptance tests pass before real-data launch | The 16-scenario suite (`packages/eval-harness/scenarios/`) runs successfully — verified as part of this package (2 scenarios spot-checked directly; the full suite was run and passed at Package 0's original construction). All 92 automated tests across `packages/api/test/` pass (see Part B below), including every cross-account isolation test. | **Completed** — see item 5's note and `packages/eval-harness/scorecard/SCORECARD.md`: the product owner has scored all 16 scenarios against a committed run, 14/16 clean, with two known, tracked (non-blocking) findings rather than an unscored blank template. Security/privacy acceptance: all 92 automated tests pass, including a dedicated cross-account isolation test in every one of the 13 test files. |
| 12 | Nate + reviewer can examine results, limitations, and deferred decisions before authorizing | This document, plus `/OPERATIONS.md` (rollout gate) and every package's README "Known limitations" section (compiled below). | Process requirement, not a code requirement — satisfied by this document existing and being read before a launch decision is made, not by anything this repository can enforce. |

## Part B — full test suite results

Every automated test across every package with a test runner (only
`packages/api` has one — `packages/db`, `packages/synthesis-core`, and
`packages/eval-harness` are typecheck-only or manually-scored, see above):

```
packages/api: npm test
ℹ tests 92
ℹ pass 92
ℹ fail 0
```

13 test files: `isolation`, `participantProfile`, `inbox`, `extraction`,
`observations`, `voice`, `timeline`, `safetyHardening`, `weeklyReview`,
`experiment`, `views`, `accountDeletion`, `goldenPath` (this package's new
file, containing both the golden-path and multi-week-gap tests).

`tsc --noEmit` passes with zero errors in all four packages
(`packages/db`, `packages/synthesis-core`, `packages/eval-harness`,
`packages/api`). `packages/eval-harness`'s `npm run eval` was smoke-tested
against 2 of its 16 scenarios (one normal, one safety-flagged) and
completed successfully.

**Zero regressions.** No existing test from any earlier package was
modified to make this package's work pass, other than fixing this
package's own two new tests' seed data/assertions during development (see
`test/goldenPath.test.ts`'s history — an overly strict assertion and a
test-only date-math error, both in the new test code, not the system
under test).

## Part C — citations for items 3, 4, 9, 11

**Item 3** ("transcribes and structures input, identifies uncertainty,
handles safety first, lets the participant confirm or correct"):
- `test/extraction.test.ts` — "a safety-flagged entry produces a
  SafetyEvent, safety_flagged status, and zero Observations" (safety
  first, hard short-circuit before extraction ever runs).
- `test/extraction.test.ts` — "a normal entry produces correctly typed,
  correctly confidence-tagged Observations" (structuring + uncertainty:
  `confidenceLevel`, always `verificationState: "proposed"`).
- `test/voice.test.ts` — "voice parity: a mocked-transcript upload flows
  through the exact same pipeline as equivalent text" (transcription
  feeding the identical downstream pipeline).
- `test/observations.test.ts` — "confirm sets verificationState to
  confirmed, no new row", "correct creates a new row with a proper
  supersession chain" (confirm/correct).

**Item 4** ("inspect and edit a daily timeline that accurately
distinguishes missing information from negative events"):
- `test/timeline.test.ts` — "a normal observation, an explicit non-event,
  and a no-entry day are all distinguishable in one response" (the direct,
  purpose-built proof of this exact requirement).
- `test/timeline.test.ts` — "provenance: correction lineage and superseded
  filtering" (the "edit" half).

**Item 9** ("safety scenarios interrupt normal coaching and display the
approved guidance; routine AI cannot override it"):
- `test/safetyHardening.test.ts` — 9 unit tests covering all 6 per-entry
  categories (`urgent_symptom`, `crisis_language`, `disordered_eating`,
  `pregnancy_related`, `extreme_restriction`, `rapid_weight_change`),
  including calibration (a scenario deliberately built to NOT trigger)
  and wording checks (protective content isn't undercut by a
  false-positive hedge).
- `test/extraction.test.ts` — "a safety-flagged entry produces a
  SafetyEvent, safety_flagged status, and zero Observations" (per-entry:
  the safety screen runs before extraction, and extraction — "routine
  AI" — never runs at all if it flags).
- `test/weeklyReview.test.ts` — "the weekly-level safety gate
  short-circuits before any synthesis call, and writes a SafetyEvent"
  (the weekly-level gate; the synthesis LLM — "routine AI" — never runs
  if it flags).
- Both of the above have a recorded "prove it would fail without the
  gate" demonstration in `packages/api/README.md` (the guard was
  temporarily disabled and the relevant test was shown to actually fail).

**Item 11** ("the AI scenario suite and security/privacy acceptance tests
pass before any real-data launch"):
- AI scenario suite: `packages/eval-harness/scenarios/` (16 fictional
  scenarios), run via `npm run eval` — verified running cleanly as part
  of this package. Manual rubric completion not verifiable from the repo
  (see the item 5/11 table notes above).
- Security/privacy acceptance: `test/isolation.test.ts` (general-purpose
  proof) plus a dedicated cross-account isolation test in every one of
  the other 12 test files — all 92 tests pass (Part B above).

## Known limitations, compiled from every package's README

This is not a new list — it's every limitation already documented across
`packages/api/README.md`, `packages/db/README.md`, and
`packages/eval-harness/rubric.md`, gathered here so a reviewer doesn't
have to hunt for them.

### Safety detection (packages/api/README.md, "Known limitations, for clinical/legal review" — Package 8)

- **This is keyword-based pattern matching, not a clinical screening
  tool.** Not designed, validated, or reviewed by a licensed mental
  health professional or eating-disorder specialist.
- **It will have false negatives** — real risk language it will not
  catch, since it only does substring matching against a finite,
  human-written keyword list.
- **It will have false positives** — ordinary language that happens to
  match a keyword. Wording softens the user-facing impact but doesn't
  reduce frequency.
- **`rapid_weight_change` only looks at a user's own history**, with no
  awareness of population norms, medical context, or plausible
  non-concerning causes (illness, medication change, a different scale).
- **None of this has been load- or adversarially-tested** against
  attempts to phrase risk language to evade detection, or against a
  large corpus of real user text — only 16 hand-written fictional
  scenarios.
- **`pregnancy_related` and `extreme_restriction` are new (Package 8)**
  and have had zero real-world exposure.
- **This system can only show a message and pause processing.** It
  cannot contact anyone, verify a user is safe, or distinguish "read and
  fine" from "never saw it."
- **Consistency caveat (`packages/eval-harness/rubric.md`)**: on
  scenarios with genuine ambiguity in the "right" next step, repeated
  runs of the synthesis engine can propose materially different (though
  each individually well-reasoned) experiments — confirmed by running
  one scenario three times. Expected behavior at the current sampling
  temperature, not a defect, but worth knowing before treating any single
  run's recommendation as the unique correct answer.

### Data model / schema judgment calls (packages/db/README.md)

- **No `updatedAt` columns** — mutable-status tables (`experiments`,
  `safety_events`, `weekly_reviews`) don't record when status last
  changed.
- **`safety_events.user_id` is nullable with `ON DELETE SET NULL`, not
  `CASCADE` (Package 11)** — an explicit product decision (see below)
  so a category+timestamp safety-incident record survives account
  deletion, anonymized, rather than being erased. **Provisional, not
  legally settled** — see "Pending external reviews" below.

### Synthesis / experiment gaps (packages/api/README.md — Packages 9-11)

- **`Experiment.target` and `Experiment.difficulty` are always `null`.**
  The Package 0 prompt output has no structured field for either.
  Populating them for real requires extending and re-validating the
  rubric-scored system prompt — a deliberate future decision, not done
  as part of this build.
- **`Experiment.rationale` is an approximation**
  (`tentativeHypotheses.join(" ")`), not an exact field correspondence —
  hypotheses explain the observed pattern, not necessarily "why this
  specific experiment."
- **No resume-from-paused transition** — an experiment can be paused and
  later retired, but not resumed back to `accepted`.
- **No `GET /api/experiments` list/get route** — every lifecycle action
  returns the resulting Experiment in its own response instead.
- **Evidence-sufficiency threshold (3 of 7 logged days) is a single
  global constant**, derived from `eval-harness`'s fixtures, not
  clinically validated or tunable per user.
- **Backfilled "skipped" weeks don't trigger any notification or
  messaging** — Progress reports an honest `skippedCount`, but there's no
  "you missed 3 weeks" UX (there's no UI at all — see the top-level
  caveat).
- **Medication context is a flag, not a fact** — per PRD Section 8.2's
  scope, no drug name or dosage is collected, so the synthesis prompt can
  only reason about medication context in general terms.

### Operational / infrastructure gaps (packages/api/README.md)

- **No background job queue** — inbox processing and voice upload run
  synchronously in the request. Fine for proving pipeline logic; would
  need real queue infrastructure before it holds up under load.
- **No retry route for `transcription_failed`** — audio is retained 48
  hours for a manual/future retry, but no retry endpoint exists yet.
- **Real OIDC login can only be verified on Replit** — no automated test
  can script the actual browser OAuth handshake.
- **Timeline and Progress queries fetch-all-then-filter-in-memory**, not
  real range queries at the DB level — fine at current scale, would need
  revisiting for years of daily data per user.
- **`@replit/object-storage`'s dependency tree has an unfixed moderate
  `uuid` advisory** — Replit's own transitive dependency choice, not
  fixable from this codebase.

### Deletion / privacy gaps (packages/api/README.md — Package 11)

- **No automatic retry for a failed `delete-confirm`** — if object
  storage deletion fails partway, the call fails safely (nothing in the
  DB is touched) but the caller must manually retry.
- **`GET /api/safety-events` doesn't exist** — SafetyEvent rows are only
  ever verified directly against the DB in tests, not exposed as an API
  response anywhere.

## Pending external reviews (per /OPERATIONS.md) — NOT YET COMPLETE

Per the rollout gate documented in `/OPERATIONS.md` since Package 9 and
extended in Package 11, **both of the following are still outstanding**
as of this document:

1. **A clinical safety review** of the safety-pathway logic and detection
   categories (`packages/api/src/inbox/safetyScreen.ts`,
   `packages/synthesis-core/safetyCheck.ts`) — **not done.**
2. **An attorney review** of Terms of Service / liability language
   covering crisis and disordered-eating content, and — added in Package
   11 — specifically asked to confirm whether SafetyEvent
   anonymized-retention-on-deletion is legally sound in every relevant
   jurisdiction, or whether record-retention/mandatory-reporting rules
   require something different — **not done.**

`/OPERATIONS.md` states plainly: "No user beyond founder solo testing
should be onboarded until both are complete." Nothing in this package
changes that. This status document does not authorize anything — it
exists so that decision can be made with full information.

## Overall readiness — stated plainly

**The backend is thorough, well-tested, and internally consistent.**
Twelve packages built a real authentication/authorization pipeline, a
three-channel ingestion system with a genuinely shared pipeline (not
three parallel ones), two independent layers of safety screening (both
with "prove it would fail" evidence, not just code that looks right), a
rubric-validated synthesis engine reused unmodified from its original
fictional-scenario validation into real user data, a full experiment
lifecycle, honest missed-time handling, and complete data export/deletion
with a real cascade proof. 92 tests pass, including a new end-to-end
golden path that chains a realistic session across all of it in one
continuous run, and zero regressions were introduced getting here.

**It is not ready for real users**, for reasons that have nothing to do
with code quality:

1. **No frontend exists.** Nobody has used this system through anything
   resembling the product a real participant would touch. Every test in
   this repo is an HTTP call, not a click.
2. **Neither pending external review is complete.** The clinical safety
   review and the attorney review are both explicitly required by this
   project's own documented rollout gate, and both are still outstanding.
3. **Resolved**: the AI scenario suite has now been scored by the product
   owner — `packages/eval-harness/scorecard/SCORECARD.md`, 16/16 scored,
   14/16 clean. Two findings are recorded as known, tracked limitations,
   not blocking issues: a prompt-calibration gap on a deterministic unit
   conversion, and confirmed run-to-run divergence between multiple
   individually-reasonable answers on two genuinely ambiguous scenarios.
   Neither blocks a launch decision on its own, but both are real and
   should be weighed, not ignored.
4. **The safety detection is explicitly, deliberately unvalidated
   clinically** — this is stated as plainly as possible in Package 8's
   own "Known limitations, for clinical/legal review" section, reproduced
   above, and nothing about finishing Package 12 changes that assessment.
5. **The SafetyEvent anonymized-retention decision is a product decision,
   not a legal one** — made explicitly (not silently) during Package 11,
   but still needs the attorney review's sign-off before it should be
   considered settled.

Authorizing the four-week founding experiment is a decision for Nate and
the product/engineering reviewer to make with all of the above in view —
not a decision this document makes or implies on its own.
