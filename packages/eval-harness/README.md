# eval-harness

Package 0 of "Our Next 50": a headless evaluation harness for the
weekly-synthesis AI logic. No web app, no database, no auth, no UI — just a
script that takes fictional scenarios and produces structured weekly
syntheses, scored manually against `rubric.md`.

## What's here

- `types.ts` — shared data model (`BaselineProfile`, `Observation`,
  `WeeklyReflection`, `PriorExperiment`, `EvidencePacket`, `SynthesisOutput`,
  `SafetyCheckResult`), written to be reusable in later packages.
- `scenarios/` — 16 fictional scenario JSON files covering the cases in the
  package spec (modest progress, plateaus, missed logging, ambiguous data,
  safety-flagged cases, etc).
- `safetyCheck.ts` — rule-based, keyword/threshold safety interrupt that runs
  before synthesis.
- `synthesisEngine.ts` — builds an `EvidencePacket` from a scenario, runs the
  safety check, and (if not flagged) calls the Anthropic API for a structured
  synthesis.
- `runEval.ts` — runs every scenario in `scenarios/` through the engine and
  writes one readable `.md` file per scenario to `output/`.
- `rubric.md` — the 9-dimension manual scoring checklist.

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
