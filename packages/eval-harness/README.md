# eval-harness

Package 0 of "Our Next 50": a headless evaluation harness for the
weekly-synthesis AI logic. No web app, no database, no auth, no UI — just a
script that takes fictional scenarios and produces structured weekly
syntheses, scored manually against `rubric.md`.

## What's here

- `types.ts` — re-exports the shared data model (`BaselineProfile`,
  `Observation`, `WeeklyReflection`, `PriorExperiment`, `EvidencePacket`,
  `SynthesisOutput`, `SafetyCheckResult`) from `packages/synthesis-core`
  (moved there in Package 9), plus `ScenarioInput`, which stays local since
  it's specific to this package's fictional fixtures.
- `scenarios/` — 16 fictional scenario JSON files covering the cases in the
  package spec (modest progress, plateaus, missed logging, ambiguous data,
  safety-flagged cases, etc).
- `safetyCheck.ts` — re-exports `packages/synthesis-core`'s rule-based,
  keyword/threshold safety interrupt (moved there in Package 9; the same
  check packages/api's weekly-level safety gate now shares).
- `synthesisEngine.ts` — `buildEvidencePacket(scenario)`, specific to this
  package's fictional fixtures, plus `synthesizeWeek(scenario)`, a thin
  wrapper that builds the packet and hands it to
  `packages/synthesis-core`'s `synthesizeFromPacket()` (the system prompt,
  the Anthropic call, and the safety-check-before-synthesis logic all live
  there now — see that package's README for why and what moved).
- `runEval.ts` — runs every scenario in `scenarios/` through the engine and
  writes one readable `.md` file per scenario to `output/`.
- `rubric.md` — the 9-dimension manual scoring checklist.

### Package 9: the engine moved to packages/synthesis-core

This package's `synthesisEngine.ts` and `safetyCheck.ts` used to contain the
full implementation. Package 9 needed the exact same, rubric-validated
system prompt and safety-check logic to run against *real* user data in
`packages/api` — duplicating the file was explicitly the fallback, not the
goal, so both packages now depend on `packages/synthesis-core` (a plain
sibling-package relative import, same pattern as this package already used
for nothing — see `packages/api/src/db.ts` for the precedent with
`packages/db`). **The system prompt text itself did not change** — it's
byte-identical to what was rubric-scored across all 16 scenarios here. Only
the file it lives in changed. Running `npm run eval` after the refactor
reproduces the exact same safety-pathway output for the deterministic
scenarios (verified byte-for-byte against the pre-refactor output for
`urgent-symptom`) and well-formed synthesis output for the LLM-driven ones.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `ANTHROPIC_API_KEY` to a valid key. Optionally override
`ANTHROPIC_MODEL` (defaults to `claude-sonnet-5`).

## Run

```bash
npm run eval
```

This runs all 16 scenarios and writes one `.md` file per scenario to
`output/` (e.g. `output/modest-progress-strong-adherence.md`). The four
safety-flagged scenarios (`urgent-symptom`, `mental-health-crisis-language`,
`possible-disordered-eating-language`, `rapid-weight-change`) will show a
"SAFETY PATHWAY TRIGGERED" banner instead of a normal synthesis — no LLM
call is made for those.

`output/` is gitignored since it's regenerated per run; only the code and
scenario fixtures are committed.

### Running a subset of scenarios

Pass one or more scenario IDs as arguments to run only those:

```bash
npm run eval -- apparent-plateau urgent-symptom
```

Each ID must match a filename in `scenarios/` (without `.json`). An unknown
ID fails immediately with an error listing all valid scenario IDs, rather
than silently skipping it.

### Comparing multiple runs of the same scenario

By default, re-running a scenario overwrites its `output/{id}.md` file. To
keep multiple runs around for consistency-checking, pass `--label`:

```bash
npm run eval -- apparent-plateau --label run2
```

This writes `output/apparent-plateau.run2.md` instead of overwriting
`output/apparent-plateau.md`. Omitting `--label` keeps the normal
overwrite-on-rerun behavior.

To type-check without running anything:

```bash
npm run typecheck
```

## Scoring

Open each file in `output/` and score it against `rubric.md` by hand. This
package does not auto-score — that's intentionally left for a later package.
