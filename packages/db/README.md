# db

Package 1 of "Our Next 50": the Postgres schema and migrations, built with
Drizzle ORM. No API routes, no auth logic, no UI — just the data model.

## Postgres provider

This package works with any standard Postgres instance (it's just the `pg`
driver + Drizzle over the wire protocol), but two are relevant here:

- **Replit's built-in Postgres** — zero-config in production: Replit
  provisions it automatically and sets `DATABASE_URL` for you. This is the
  intended provider for the deployed app.
- **Neon** — a separate, internet-reachable Postgres instance.

**Important finding from setting this up:** Replit's built-in Postgres uses
an internal hostname (`helium`) that only resolves *inside* Replit's
network. It is not reachable from a local machine, CI, or anywhere outside
Replit. So while it's the right choice for the deployed app, you'll need a
separate reachable database (like Neon) for local development, CI, or any
tooling that runs outside Replit — which is exactly why this package's
migration was generated here but verified end-to-end against a Neon
instance. Nothing about the schema or code changes between the two; it's
purely a matter of which `DATABASE_URL` you point at.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `DATABASE_URL` to your Postgres connection string
(Replit's auto-provisioned one in Replit, or a Neon connection string
locally/in CI — see above).

## Commands

Generate a migration from the schema (after editing files in `src/schema/`):

```bash
npm run generate
```

This reads `src/schema/index.ts` and writes SQL into `drizzle/` — never
hand-write migration SQL; always change the schema and regenerate.

Apply pending migrations to the database at `DATABASE_URL`:

```bash
npm run migrate
```

Type-check without running anything:

```bash
npm run typecheck
```

## Schema layout

Each entity lives in its own file under `src/schema/`, re-exported from
`src/schema/index.ts` (the entry point `drizzle.config.ts` reads). Shared
enums live in `src/schema/enums.ts`. `src/client.ts` exports a configured
Drizzle client (`db`) for later packages to import — connecting to Postgres
is infrastructure this schema needs to be usable, not application logic.

Every table has a `uuid` primary key (`defaultRandom()`), a `createdAt`
timestamp, and foreign keys with explicit `ON DELETE` behavior. The general
rule: **deleting a `User` cascades to every table that stores that user's
own data** (so a full account deletion never leaves orphaned rows), while
references from durable records to raw/ephemeral capture records (an
`InboxEvent`, a `Transcript`) use `SET NULL` — purging a raw payload per
retention policy should never delete the derived record built from it.
`AuditEvent` is a deliberate exception to the cascade rule (see below).

### Tables

**`users`** — one row per account: email, which auth provider vouches for
it, locale, timezone, and which consent/ToS version they accepted and when.
`consentVersion`/`consentAcceptedAt` are nullable — a row is created on
first login, before consent is captured (see `packages/api`'s consent
gate). This is the root of the "delete cascades to a user's own data" chain.

**`sessions`** — not a PRD Section 12 entity. Infrastructure for
`connect-pg-simple`, the Postgres-backed `express-session` store used by
`packages/api`. Its shape (`sid`/`sess`/`expire`) is dictated entirely by
that library, which manages the table's rows itself; app code never queries
it directly.

**`participant_profiles`** — baseline intake data (age/DOB, height,
starting weight, optional waist, goals, personal reason, typical
eating/sleep/activity patterns, exercise preferences, physical limitations,
high-level health context, and a weight-management-medication flag).
**Versioned**: editing the profile inserts a new row with an incremented
`version` rather than updating in place, so old versions are retained.
`weekly_reviews` references a specific version by ID, recording exactly
which profile snapshot was active when that review was generated.

**`inbox_events`** — one row per incoming user interaction (voice, text, or
form submission today; `channel` is a Postgres enum so new channels can be
added later without a code change to this table). Tracks a coarse `status`
lifecycle and a finer free-text `processingState`. Content lives in one of
two places depending on the channel: `payload` (jsonb) holds inline content
small enough to store directly (text/form submissions), while
`rawPayloadRef` is a pointer (not a copy) to a blob in storage, for channels
where the content itself is large (e.g. voice's audio file). Every channel
produces the same top-level column shape — only what's inside `payload`
varies by channel. `status` includes two pipeline outcomes from Package 5's
extraction pipeline: `safety_flagged` (a per-entry safety screen matched
before any extraction happened — see `safety_events`) and `needs_followup`
(extraction proposed its one allowed follow-up question, held in
`pendingFollowUpQuestion` until answered).

**`source_artifacts`** — metadata about an audio recording or attachment
tied to an `InboxEvent` (type, size, storage pointer, retention state). Like
`inbox_events`, stores a pointer to the blob, not the blob itself.

**`transcripts`** — speech-to-text output for a `source_artifact`: which
model/version produced it, a confidence score, and the transcribed text.

**`observations`** — the most important table in the schema. One row per
logged data point, typed as one of 11 kinds (weight, waist, sleep, meal,
hunger, energy, activity, experiment completion, context/reflection,
symptom/safety-relevant, non-scale win). It's deliberately wide: `value`/
`unit` hold the primary number when one exists (a weight, sleep hours, a
hunger level), `textValue` holds free text (a meal description, a
reflection, a symptom), and `structuredDetails` (jsonb) holds any
type-specific extra shape. Every row records **confidence** (measured /
user-reported / approximate) and **verification state** (proposed /
confirmed / corrected), plus **provenance** — which `InboxEvent` and/or
`Transcript` it came from, if any. **Supersession**: correcting an
observation never deletes the old row. A new row is inserted with
`supersedesObservationId` pointing back at the old one, and the old row's
`isSuperseded` flag is set to `true` — both in the same transaction, by the
application (there's no DB trigger enforcing this). Per PRD Section 8.4,
"no entry" and "did not happen" are distinct states: **absence of a row**
for a given user/date/type still means "no entry" (unknown), while
**`isExplicitNonEvent`** (default `false`) marks a row that exists because
the user actively reported that nothing happened — "no activity today,"
"skipped dinner" — as opposed to a normal positive observation. Both kinds
are ordinary rows in this table; the flag just distinguishes which kind a
given row is.

**`program_weeks`** — one calendar week of a user's program: date range,
which completed-week number it is, whether there's enough evidence to
generate a review that week, a link to that week's reflection (itself
stored as an `observations` row of type `context_reflection`), and a status.

**`weekly_reviews`** — the AI-generated synthesis for one `program_week`.
Records which `program_week` and which `participant_profiles` version were
used, the AI model and prompt version, a `structuredClaims` jsonb column
that mirrors `SynthesisOutput` in `packages/eval-harness/types.ts`
(recordedFacts, observationsSummary, tentativeHypotheses, whatsWorking,
friction, whatShouldRemainUnchanged, proposedNextStep — kept in sync with
that file intentionally), the rendered human-readable report, a status, and
optional user feedback. Which observations fed into a given review is
tracked by the `weekly_review_input_observations` join table below, since a
review typically draws on many observations.

**`weekly_review_input_observations`** — join table recording which
`observations` rows were part of a `weekly_review`'s input snapshot.

**`experiments`** — a proposed behavior change, usually originating from a
`weekly_review`'s proposed next step: the recommendation, rationale, a list
of behaviors explicitly called out as unchanged, a target, difficulty,
status (proposed / accepted / modified / declined / paused / retired), and
an outcome summary. Which observations count as completion check-ins for an
experiment is tracked by the join table below.

**`experiment_completion_observations`** — join table recording which
`observations` rows (typically type `experiment_completion`) are
check-ins/completions for a given `experiment`.

**`safety_events`** — a safety-pathway trigger (the production counterpart
to the rule-based detector in `packages/eval-harness/safetyCheck.ts`).
Per the PRD's data-minimization guidance, this table deliberately stores a
policy category, a triage confidence score, a pathway key, a system
version, and **references** to the triggering `observation`/`inbox_event`
— never a copy of transcript or reflection text.

**`audit_events`** — enough to reconstruct who-did-what-when for a security
review, with no duplicated sensitive payloads: an actor, an action type, a
polymorphic target (`targetEntityType` + `targetEntityId`, which can't be a
single Postgres foreign key since it points at different tables), and a
timestamp. **Deliberate exception to the cascade-on-user-delete rule**:
`actorUserId` and `subjectUserId` use `ON DELETE SET NULL`, not `CASCADE`,
so the audit trail survives account deletion for security-review purposes —
the row is kept (with a null actor/subject link) rather than removed.

## Known limitations / judgment calls worth knowing about

- **No `updatedAt` columns.** Only `createdAt` was in scope per the package
  spec. Tables with a mutable `status` (e.g. `experiments`, `safety_events`,
  `weekly_reviews`) don't currently record when that status last changed —
  a future package could add `updatedAt` or a status-history table if that's
  needed.
- **`participant_profiles.dateOfBirth` / `ageRange`** are both nullable;
  the app layer decides which to collect. Not enforced at the DB level.
- **`program_weeks.completedWeekNumber`** is nullable, since it only makes
  sense once a week is actually completed (a `scheduled` week doesn't have
  one yet).
- **A known, moderate-severity, dev-only advisory** exists in the latest
  published `drizzle-kit` itself (it depends on a deprecated `@esbuild-kit`
  package with an `esbuild` dev-server advisory). It's a `devDependency`
  only, never shipped to production, and the vulnerable esbuild dev-server
  feature is never invoked by `drizzle-kit generate`/`migrate`. Not
  something fixable from this package without pinning to an older,
  differently-vulnerable `drizzle-kit` version.

## Verification

`npm run generate` produced a clean 13-table migration with no errors
(11 entities from PRD Section 12 + 2 many-to-many join tables:
`weekly_review_input_observations` and `experiment_completion_observations`,
needed because "which Observations a WeeklyReview used" and "which
Observations complete an Experiment" are both many-to-many relationships,
not single foreign keys). `npm run migrate` applied it successfully against
a real Neon Postgres instance, and all 13 tables were confirmed present via
`information_schema.tables` afterward.
