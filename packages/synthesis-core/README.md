# synthesis-core

Introduced in Package 9 of "Our Next 50": the shared weekly-synthesis
engine — system prompt, EvidencePacket/SynthesisOutput data model, and the
weekly-level safety check — used by both `packages/eval-harness` (fictional
scenarios, Package 0) and `packages/api` (real user data, Package 9). No
web app, no database, no auth — just the engine.

## Why this exists

Package 0 built and rubric-validated a weekly-synthesis prompt against 16
fictional scenarios, entirely inside `packages/eval-harness`. Package 9
needed to run that *exact same* prompt against real user data in
`packages/api`. Two options: duplicate the file, or share it. Duplicating
it would mean the two copies drift the moment either package edits its
"local" version, and the whole point of the rubric scoring was to validate
one specific prompt — a silently-diverged copy defeats that. So this
package exists to be depended on by both, via a plain relative import (no
npm workspace, no build/publish step — same pattern `packages/api/src/db.ts`
already uses for `packages/db`).

**The system prompt in `synthesisEngine.ts` must not be edited casually.**
It's the same text that was rubric-scored across 16 scenarios in Package 0.
If it ever needs to change, that's a deliberate decision requiring
re-validation, not a drive-by edit.

## What's here

- `types.ts` — the core data model: `BaselineProfile`, `Observation`,
  `WeeklyReflection`, `PriorExperiment`, `MedicationContext`,
  `EvidencePacket`, `SafetyCategory`, `SafetyCheckResult`,
  `ProposedNextStep`, `SynthesisOutput`. Deliberately does **not** include
  `ScenarioInput` — that's specific to eval-harness's fictional fixtures and
  stays there.
- `safetyCheck.ts` — `runSafetyCheck(packet)`: the rule-based,
  keyword/threshold safety interrupt that runs before synthesis. Evaluates
  the *whole* EvidencePacket (a week's worth of evidence) at once — this is
  what makes it meaningfully different from `packages/api`'s per-entry
  `safetyScreen.ts` (Package 5/8), which only ever sees one entry at a time.
- `derivedMetrics.ts` — pure functions (`computeWeightTrend`,
  `computeAverageSleepHours`, `computeAverageHungerLevel`,
  `daysBetweenInclusive`) over an `Observation[]`, extracted from
  eval-harness's original packet-building code so any caller assembling its
  own `Observation[]` (fictional or real) can compute the same derived
  facts the same way.
- `synthesisEngine.ts` — the system prompt, the Anthropic API call, response
  parsing, and `synthesizeFromPacket(packet)`: runs the safety check first
  and, only if it doesn't flag, calls the model. This is the one function
  every caller needs — everything upstream of "I have an EvidencePacket" is
  caller-specific and lives in the caller's own package instead (see below).

## What's deliberately NOT here

Building an `EvidencePacket` in the first place is caller-specific and
stays out of this package on purpose:

- `packages/eval-harness/synthesisEngine.ts`'s `buildEvidencePacket(scenario)`
  turns a hand-authored fictional `ScenarioInput` fixture into a packet.
- `packages/api/src/weeklyReview/evidencePacket.ts`'s
  `assembleEvidencePacket(...)` turns real, polymorphic Observation rows
  from Postgres (11 types, free-form `structuredDetails`, per-row
  confirmed/proposed state) into the same packet shape — a much more
  involved mapping, documented in that file.

Both end up calling this package's `synthesizeFromPacket()` with the result.
Neither of those builder functions belongs here: they have nothing in
common except their output type, and folding either one in would make this
package depend on either eval-harness's fixture format or packages/api's
DB schema — exactly the coupling this refactor was meant to avoid.

## Setup

```bash
npm install
```

No `.env` of its own — callers (`packages/eval-harness`, `packages/api`)
already load `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` before calling into
this package, and `synthesisEngine.ts` just reads `process.env` directly.

```bash
npm run typecheck
```
