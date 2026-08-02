# api

Packages 2 through 7 of "Our Next 50".

**Package 2** built authentication, session handling, consent capture, and
server-side row-level authorization — entirely about "who is this request
from, and can they only ever touch their own data." No inbox/synthesis/
experiment features.

**Package 3** built on top of that: the real ParticipantProfile baseline
onboarding flow (PRD Section 8.2), replacing Package 2's placeholder
`participantProfiles` CRUD-by-id routes (that package's README explicitly
flagged them as minimal wiring for "a future package" to properly own).

**Package 4** added inbox ingestion for the text and form channels (INB-01).
Voice is deliberately deferred to Package 6; extraction into Observations
is Package 5's job. That package's responsibility ended at "the raw
submission is durably, correctly, and identically-shaped stored."

**Package 5** built the extraction pipeline that turns a stored InboxEvent
into proposed Observations: a per-entry safety screen first (PRD Section
9), then LLM-based extraction only if not flagged, plus the confirm/
correct/list routes for a user to act on what was extracted (INB-07). No
background job queue — see "Inbox extraction pipeline" below.

**Package 6** added the voice channel, extending — not replacing — that
pipeline: upload audio, transcribe it, reduce the transcript to the exact
same `{ text }` payload shape text already uses, and hand off to the
**unmodified** `runPipeline()` from Package 5. See "Voice channel" below.

**Package 7** built the Timeline — the read/query layer over Observations,
plus presenting the confirm/correct routes Package 5 already built as one
coherent "view → confirm/correct" story. No new write logic. See
"Timeline" below.

## Framework choice

**Express**, plain and minimal. This package doesn't need anything a
heavier framework (Fastify, NestJS, ...) would justify — a handful of
routes, some middleware, and a well-established Replit Auth integration
pattern that's documented (informally, across many public examples) against
Express/Passport specifically.

## Setup

```bash
npm install
cp .env.example .env
```

- `DATABASE_URL` — same Postgres instance as `packages/db` (this package
  reads its schema directly; see "How this package uses packages/db" below).
- `SESSION_SECRET` — any long random string, used to sign session cookies.
- `PORT` — defaults to 3000.
- `REPL_ID`, `REPLIT_DOMAINS` — set automatically by Replit when running in
  a Repl. Outside Replit (this local machine, CI), leave them unset: the
  server still starts and the health check still works, but `/api/login`
  and `/api/callback` won't be registered (a warning is logged, not a
  crash) since there's no real OIDC client to discover against.
- `ISSUER_URL` — defaults to `https://replit.com/oidc`; you shouldn't need
  to change it.
- `ANTHROPIC_API_KEY` (and optional `ANTHROPIC_MODEL`) — used by the
  Package 5 extraction pipeline.
- `DEEPGRAM_API_KEY` (and optional `DEEPGRAM_MODEL`) — used by the
  Package 6 voice channel's transcription step. Not needed outside Replit
  or in tests — `NODE_ENV=test` uses a stubbed transcription path instead
  (see "Voice channel" below).

## Run

```bash
npm run dev     # starts the server (ts-node src/index.ts)
npm test        # runs both test files (node's built-in test runner)
npm run typecheck
```

Health check: `GET /api/health` → `{"status":"ok"}`, unauthenticated,
public. This is what confirms the server is actually running — verified
locally (see below) and needs to also be verified on Replit itself.

**On Replit**, after this is deployed/run there: hit the Repl's URL at
`/api/health` and confirm the same `200 {"status":"ok"}` response, then log
in via `/api/login` with a real Replit account and confirm a `users` row
gets created (see ACC-01 below) — I can't drive a real Replit OIDC login
from this local environment, so that step needs to happen on Replit itself
before this package is truly done.

## How this package uses packages/db

`src/db.ts` re-exports `packages/db`'s schema and client via a relative
import (`../../db/src/schema`, `../../db/src/client`) rather than a real
npm dependency — the two packages are siblings in this monorepo with no
build/publish step between them, so a relative import is the simplest
correct way to share the schema without setting up npm workspaces for a
two-file dependency. Every other file in this package imports from `./db`,
not from `packages/db` directly.

## The auth/authorization pipeline (ACC-01 / ACC-02 / ACC-03)

Middleware order in `src/app.ts` encodes the whole story — each stage
narrows what the next stage can assume:

```
public                  -> healthRouter
+ verified session      -> isAuthenticated       (replitAuth.ts)
+ resolved user row      -> resolveAppUser        (ACC-01)
+ (may not have          -> consentRouter          (works regardless of
  consented yet)                                    consent status)
+ current consent       -> requireConsent          (ACC-03)
+ scoped data handle    -> attachScopedData        (ACC-02)
-> everything else (participantProfilesRouter, and every future router)
```

### ACC-01 — exactly one user, from the server-verified session only

`replitAuth.ts` establishes a session via Replit's OIDC flow (or, in tests,
via a test-only route — see below) and puts the verified claims on
`req.user.claims`. `middleware/resolveAppUser.ts` runs next: it looks up
(or, on first login, creates) a `users` row keyed on
`(authProvider, authProviderId) = ("replit", claims.sub)`, using **only**
`claims.sub`/`claims.email` — never anything from `req.body`, `req.query`,
or a header. The resolved row is attached as `req.appUser`. No route
handler ever receives or trusts a client-supplied `userId`.

### ACC-02 — row-level authorization as a structural guarantee, not a habit

This is the pattern every future package should reuse rather than
reinventing per-route checks. `src/data/scopedDataAccess.ts` exports
`createScopedDataAccess(userId)`, which returns an object exposing typed
`list/findById/create/update/remove` methods **per user-owned table**, each
of which always ANDs `eq(table.userId, userId)` into the query.
`middleware/attachScopedData.ts` creates one of these per request (from
`req.appUser.id`) and attaches it as `req.data`.

The important part: **route handlers never get a reference to the raw
`db` object or table exports for user-owned tables at all** — `src/db.ts`
is only imported by `scopedDataAccess.ts` and a couple of
auth/consent-specific files that touch the `users` table directly (which
isn't user-owned data in the same sense). A route handler literally has no
way to write `db.select().from(observations)` without a userId filter,
because it never has `db` in scope in the first place — only `req.data`.
That's what "structurally impossible," not just disciplined, means here.

**To wire up a new user-owned table in a future package:** add one line to
`createScopedDataAccess` in `scopedDataAccess.ts`
(`observations: createScopedTableAccess(observations, userId)`), then use
`req.data.observations.*` in routes. Do not query that table anywhere else.
`inboxEvents` (Package 4), `observations`/`safetyEvents` (Package 5), and
`sourceArtifacts`/`transcripts` (Package 6) all followed exactly this
pattern — no new access method was ever added, including for
`GET /api/inbox`/`GET /api/observations`'s pagination and
superseded-filtering, which just sort/slice/filter the result of the
existing `list()` in the route handler rather than inventing new query
methods. Package 7's Timeline pushes this further: it needs a join across
two tables (`observations` and `inboxEvents` for provenance), and still
adds zero new methods — both `list()`s are called and joined in memory in
`routes/timeline.ts`.

### ACC-03 — consent gate

`src/consent.ts` defines `CURRENT_CONSENT_VERSION`. `GET /api/consent`
returns the current consent document plus whether this user has accepted
it; `POST /api/consent/accept` writes `consentVersion`/`consentAcceptedAt`
onto the user's row (rejecting any version string that doesn't match the
current constant). Both routes work regardless of consent status.
`middleware/requireConsent.ts` blocks every other route with `403
consent_required` until `req.appUser.consentVersion === CURRENT_CONSENT_VERSION`
— so bumping the constant re-gates every existing user until they re-accept.

### ACC-05 — safe-by-default request logging

`middleware/requestLogger.ts` logs exactly `{method, path, status,
durationMs, userId}`, one JSON line per request, nothing else — never a
request or response body, never query strings or headers. This is the
pattern for every future package's logging; don't add body/query logging
anywhere without re-reading PRD Section 11 first.

## ParticipantProfile onboarding (`src/routes/participantProfiles.ts`)

PRD Section 8.2's baseline onboarding flow. `src/participantProfile/types.ts`
lists every field this profile collects — deliberately exhaustive, nothing
more — and each one carries a one-line comment naming which downstream use
justifies it (review logic, safety logic, unit handling, or experiment
selection). `src/participantProfile/validation.ts` hand-validates requests
against that list with no validation library dependency; anything not on
the list is silently dropped, never reaches the database, however much
room `packages/db`'s schema might otherwise have.

These are **self-service routes**: reading or editing "my profile" takes no
id parameter at all — everything is derived from `req.appUser` via
`req.data`. That removes an entire class of cross-account bugs by
construction, since there's no id in the request for a handler to forget
to scope. The one route that does take an id (`GET /:id`, for a specific
historical version) goes through the same scoped `findById` as every other
package.

- `POST /api/participant-profiles` — create the first version. `409` if a
  profile already exists (edit via `PATCH` instead). All required fields
  must be present; no field is silently defaulted (notably
  `onWeightManagementMedication`, which the DB column defaults to `false`
  but the API requires explicitly — "unanswered" and "no" aren't the same
  thing for a field this safety-relevant).
- `GET /api/participant-profiles/current` — the latest version. `404` if
  none exists yet.
- `GET /api/participant-profiles/versions` — every version, oldest first.
- `GET /api/participant-profiles/:id` — one specific version by its row id.
- `PATCH /api/participant-profiles/current` — partial edit. The request
  only needs to carry what's changing; it's merged onto the current
  version's values, the **merged whole** is re-validated with the same
  rules as creation (so an edit can never produce a version that's missing
  a required field), and the result is inserted as
  `currentVersion + 1` — **never** an update to the existing row. The old
  version is left exactly as it was and stays queryable by its id or via
  `/versions`.

## Inbox ingestion (`src/routes/inbox.ts`) — INB-01

Text and form submissions (PRD Section 13's "one-minute structured
check-in" for the latter) both create exactly one `InboxEvent` row each,
via the identical `req.data.inboxEvents.create()` call — differing **only**
in `channel` and what's inside `payload` (`src/inbox/types.ts`:
`{ text: string }` for text, `{ weight?, hungerLevel?, note? }` for form,
each field individually optional but the form as a whole requiring at
least one). Every event is created with `status: "received"` and left
alone — extraction only happens when `POST /:id/process` is explicitly
called (see "Inbox extraction pipeline" below). Voice (Package 6) is the
reason `packages/db`'s
`inboxEvents.payload`/`rawPayloadRef` split exists at all: text/form
content is small enough to live inline in `payload`, while a future
blob-based channel would populate `rawPayloadRef` instead — but the
InboxEvent row's top-level shape stays identical regardless.

- `POST /api/inbox/text` — free-form text. Rejects an empty/missing
  string.
- `POST /api/inbox/form` — the structured check-in. Rejects a submission
  where none of `weight`/`hungerLevel`/`note` are present — the form
  exists for speed, not completeness, so there's no reason to accept
  nothing at all.
- `GET /api/inbox` — the caller's own events, most recent first, paginated
  via `?limit=&offset=` (no new query capability — see the ACC-02 section
  above). This is the first "can I see what I submitted" surface; a real
  Timeline view is a later package.

## Inbox extraction pipeline (`src/inbox/pipeline.ts`) — PRD Section 9/10

`POST /api/inbox/:id/process` turns a stored InboxEvent into proposed
Observations. **Synchronous, triggered explicitly — no background job
queue in this package.** A real queue (so processing doesn't block the
request, and can retry) is future infrastructure; this package proves the
pipeline logic itself. `409`s if the event isn't in `received` status
(already processed, or already flagged), so it can never run twice.

The pipeline order is the single most important property here, mirroring
PRD Section 9 exactly:

1. **Safety screening, first, always** (`src/inbox/safetyScreen.ts`).
   Ported from `packages/eval-harness/safetyCheck.ts`'s keyword lists —
   same rule-based approach, adapted from a full week's evidence packet to
   one InboxEvent's text. Covers `urgent_symptom`, `crisis_language`, and
   `disordered_eating` (matching `packages/db`'s `safetyPolicyCategoryEnum`
   naming directly, since this module writes real `SafetyEvent` rows).
   **Not ported**: eval-harness's rapid-weight-change check — that's a
   trend detector over multiple weeks' observations, not something that
   operates on one entry's free text, so it doesn't fit this package's
   scope by the PRD's own framing. If flagged: a `SafetyEvent` row is
   written per matched category (category + pathway key + a reference to
   the InboxEvent — **never** the flagged text itself, per PRD Section 11
   and this table's design from Package 1), the InboxEvent's status
   becomes `safety_flagged`, and the pipeline stops — no LLM call is ever
   made, mirroring the short-circuit pattern already proven in Package 0's
   `synthesizeWeek()`.
2. **Extraction, only if not flagged** (`src/inbox/extraction.ts`, same
   `getClient()`/system-prompt/JSON-parsing shape as
   `packages/eval-harness/synthesisEngine.ts`, new dependency for this
   package: `@anthropic-ai/sdk`, explicitly directed by this package's
   spec). The model extracts zero or more Observations typed against the
   11 `observationType` values, each with a `confidenceLevel` — a precise
   stated figure is `measured`, a self-reported/approximate statement is
   `user_reported`, and nothing inferred is ever marked `measured`. Every
   written Observation gets `verificationState: "proposed"` regardless of
   how unambiguous it looked — **nothing in this pipeline ever
   auto-confirms**; confirming is always a separate user action (INB-07,
   below). The model may propose **at most one** follow-up question
   (INB-06), and only when answering it would materially improve safety or
   interpretation — never to chase precision on a low-value detail.
3. **Channel-agnostic by construction**: `pipeline.ts`'s only
   channel-specific code is a small `payloadToText()` adapter (text →
   `payload.text`; form → a synthesized description of
   `weight`/`hungerLevel`/`note`) — everything downstream of that (safety
   screening, extraction, writes) is identical regardless of channel. This
   is INB-01's payoff from Package 4: the processor really does treat
   every channel the same.
4. **Follow-up flow**: if extraction proposes a question, the InboxEvent's
   status becomes `needs_followup` and the question is stored in
   `pendingFollowUpQuestion`. `POST /api/inbox/:id/follow-up-answer`
   accepts `{ answer }`, re-runs the pipeline with the answer folded in as
   extra context (safety-screened again first — it's new user text), and
   finalizes to `processed`. The second pass can **never** propose another
   follow-up: `extractObservations()` discards any `followUpQuestion` the
   model returns when an answer was supplied, regardless of what the raw
   model output contains — "at most one, ever" is enforced in code, not
   left to the prompt alone (see `test/extraction.test.ts`'s direct test
   of this).
5. **No follow-up**: Observations are written directly and status becomes
   `processed`.

## Voice channel (`src/routes/voice.ts`, `src/voice/`)

Extends — does not replace — the pipeline above. `POST /api/inbox/voice`
does the whole flow synchronously in one request (upload → transcribe →
the shared pipeline → retention decision): no background job queue here
either, same as `/process` (see "No background job queue" below).

**The one rule this whole feature is built around:** `pipeline.ts` has
**zero** voice-specific code. Once transcription succeeds, the
InboxEvent's `payload` is set to `{ text: <transcript> }` — the *exact*
shape the text channel already uses — and `payloadToText()` was changed
from a per-channel `if (channel === "text")` branch to a shape check
(`if (typeof payload.text === "string")`), so voice is handled by the
same code path as text without the pipeline needing to know voice exists.
`test/voice.test.ts`'s parity test proves this: a mocked-transcript
upload and an equivalent `POST /api/inbox/text` call are asserted to
reach the same pipeline outcome and produce Observations with an
identical top-level field set (Package 4's structural-symmetry principle,
extended to a third channel).

### Storage and transcription provider choices

**Audio storage: Replit's built-in object storage** (`@replit/object-storage`),
behind an `AudioStorage` interface (`src/voice/storage.ts`) so tests don't
need live Replit infrastructure — same reasoning as `replitAuth.ts`'s
`NODE_ENV=test` bypass for the OIDC handshake, and the same situation
documented in `packages/db/README.md` for Postgres: Replit's storage is
only reachable from inside a Repl, not from this local dev machine. Tests
use a local-filesystem stub (`.local-audio-storage/`, gitignored) instead.
**Never a public URL either way** — every read goes through
`GET /api/inbox/:id/audio`, which checks ownership via the InboxEvent's
`userId` (through `req.data`, ACC-02) before storage is ever touched. A
cross-account request 404s at that check; it never reaches storage.

**Transcription: Deepgram** (`@deepgram/sdk`), chosen over OpenAI's
Whisper API and Groq specifically for its **configurable zero-retention**
option, a better structural fit for PRD Section 17/11's instruction to
weigh and document provider retention behavior than a policy-only "we
don't train on your data" assurance (OpenAI's approach) or a newer
product whose retention terms are less established (Groq). Every
transcription request sets `mip_opt_out: true`, which excludes it from
Deepgram's Model Improvement Program — data is retained only as long as
needed to process the request. `src/voice/transcription.ts` uses the
`nova-3` model by default (override with `DEEPGRAM_MODEL`).

### Audio retention (INB-04)

- **Default**: audio is deleted from storage and the `SourceArtifact`'s
  `retentionState` becomes `deleted` immediately after the pipeline
  finishes — regardless of its outcome (`processed`, `safety_flagged`, and
  `needs_followup` all count as "successfully processed"; the audio has
  served its purpose once transcribed). Chosen for simplicity now, as the
  package spec explicitly allowed; PRD Section 8.4's version-history idea
  doesn't apply to raw audio the same way it does to Observations, so
  there's no need to wait for a user's confirm/correct action first.
- **`keep=true`** (a form field on the upload) skips deletion — the
  `SourceArtifact` stays `active` and the audio remains fetchable via
  `GET /api/inbox/:id/audio`.
- **Transcription failure**: the audio is **not** deleted — status becomes
  `transcription_failed` and the `SourceArtifact` stays `active`, so a
  retry is possible. It isn't retained forever, though:
  `scripts/cleanupFailedVoiceUploads.ts` deletes audio still `active` on a
  `transcription_failed` InboxEvent older than **48 hours**
  (`EXPIRY_HOURS`, easy to change in that file). Run it manually
  (`npm run cleanup:voice`) or via a cron entry — a real job scheduler is
  future infrastructure this package doesn't build (see "No background
  job queue" below). The script uses `db` directly rather than
  `req.data`/`scopedDataAccess`, since it's a maintenance job spanning all
  users by design, not a per-request handler — the boundary that keeps it
  safe is "only run manually/via cron," not per-user scoping.

### Recording lifecycle (InboxEvent.status, INB-02)

`received` (upload landed) → `processing` (transcription in flight) →
either `transcription_failed` (distinct from the generic `failed`) or one
of Package 5's existing outcomes (`safety_flagged` / `needs_followup` /
`processed`). A full UI for this (progress indicator, retry button) is a
later package — these are the backend states it will read.

## Timeline: view, then confirm/correct (Package 7)

The full story a client builds against is "view what was logged, then act
on it" — two capabilities that happen to have been built in different
packages, presented here as one surface. **Nothing in this section is new
write logic**: `GET /api/observations` (Package 5) still exists for a flat
list; the routes below are a richer, date-oriented read layer over the
exact same `observations` rows, joined against `inboxEvents` in memory via
the existing `req.data.observations.list()`/`req.data.inboxEvents.list()`
(both already scoped, ACC-02) — no new `scopedDataAccess` method was
added, same "reuse what exists" pattern every package since Package 4 has
followed.

### `GET /api/timeline` — view a date range

`?from=&to=` (ISO dates, both inclusive). Defaults to the last 30 days
ending today if omitted. `400`s if either date is malformed, if `from` is
after `to`, or if the range exceeds 366 days (`MAX_RANGE_DAYS` in
`routes/timeline.ts` — a sanity cap, not something asked for explicitly,
against an unbounded response). `?includeSuperseded=true` works the same
way it does on `GET /api/observations`.

Response: `{ from, to, days: [...] }`, one entry per **calendar date in
the requested range, always** — a date with nothing logged still gets an
entry, with `observations: []`. This is the deliberate choice PRD Section
8.4 required picking: **"no entry" is represented by an always-present
day-group with an empty `observations` array, never by omitting the date
from the response.** A client should never have to compute "which dates
are missing" by diffing against the range it asked for. Days are ordered
oldest → newest; observations within a day, oldest → newest by
`createdAt`.

Each day-group:

```json
{
  "date": "2026-07-11",
  "hasExplicitNonEvent": true,
  "observations": [ /* TimelineObservationResponse[] */ ]
}
```

`hasExplicitNonEvent` is computed from whatever's in that day's
(filtered) `observations` array — an **explicit, per-date boolean**, not
something a client has to notice by scanning every row's
`isExplicitNonEvent` field itself (PRD Section 8.4's requirement). The
three states Section 8.4 cares about are now each unambiguous from the
response alone:

| State | `observations` | `hasExplicitNonEvent` |
| --- | --- | --- |
| Normal logged observation | `[{ isExplicitNonEvent: false, ... }]` | `false` |
| Explicit non-event ("didn't work out today") | `[{ isExplicitNonEvent: true, ... }]` | `true` |
| No entry at all | `[]` | `false` |

`test/timeline.test.ts`'s first test asserts all three side by side from
one response, specifically so the distinction can't be "broken but each
case's test still passes in isolation."

### `GET /api/timeline/:date` — full detail for one day

Same day-group shape as above, standalone, for one `YYYY-MM-DD`. `400` on
a malformed date. **Never `404`** for a valid date with nothing logged —
that's a legitimate "no entry" state (`observations: []`), not a missing
resource; `:date` is a filter, not an id.

### Provenance on every observation (`TimelineObservationResponse`)

Every observation returned by either route above carries everything
`GET /api/observations` already exposes, plus:

- **`channel`**: `"text" | "form" | "voice" | null`, resolved by joining
  `sourceInboxEventId` against the matching `InboxEvent`. `null` means
  there's no source `InboxEvent` — which, given how `PATCH
  /api/observations/:id/correct` writes its new row (see below), reliably
  means **this row exists because of a direct user correction**, not
  because of a processed submission.
- **`isCorrection`**: `supersedesObservationId !== null`, surfaced as its
  own boolean rather than something a client infers from a raw id field.

### Acting on what you see (Package 5, INB-07 — unchanged, just documented here)

- `POST /api/observations/:id/confirm` — sets `verificationState` to
  `confirmed`. No new row — confirming doesn't change the value, just
  trust in it. `409`s on an already-superseded row (confirm the current
  version instead).
- `PATCH /api/observations/:id/correct` — the exact versioning idea already
  proven in Package 3's ParticipantProfile edit flow, applied to a
  different table: never mutates the old row. Inserts a new row with the
  corrected value, `verificationState: "confirmed"` (a user's own
  correction is authoritative), `supersedesObservationId` pointing at the
  old row, and marks the old row `isSuperseded: true`. `type` can't be
  changed via a correction (if the type itself was wrong, that's a
  different kind of edit this endpoint doesn't attempt); `confidenceLevel`
  defaults to `user_reported` unless explicitly overridden. `409`s on an
  already-superseded row, same reasoning as confirm. This row's
  `sourceInboxEventId` is always `null` — see "Provenance" above for what
  that implies in the Timeline response.
- `GET /api/observations` — the caller's own observations, most recent
  first (flat, not date-grouped — `GET /api/timeline` is the date-oriented
  view of the same data), excluding superseded rows by default;
  `?includeSuperseded=true` includes them.

## Test suites

**`test/isolation.test.ts`** — general auth-pipeline proof: an
unauthenticated request to a protected route gets `401`, and the consent
gate blocks a freshly-created user from other routes (`403`) until they
accept (`200`), after which they can proceed (`201`).

**`test/participantProfile.test.ts`** — the ParticipantProfile-specific
proof, covering both the package's functional requirements and its own
from-scratch cross-account isolation check (Package 2's isolation coverage
doesn't carry over automatically to routes it never exercised — this is
the "prove it again" for this route surface):

1. Create only persists Section 8.2 fields — unrelated fields in the
   request body (e.g. lab results, a photo URL) are silently dropped, not
   stored or echoed back.
2. A second `POST` for a user who already has a profile is rejected (`409`).
3. An incomplete `POST` (missing a required field) is rejected (`400`)
   rather than silently defaulted.
4. `GET current` returns exactly what was created.
5. `PATCH current` creates version 2, the version-1 row is unchanged and
   still fetchable by id, and both versions appear in `/versions`.
6. User B cannot read user A's profile by id (`404`).
7. User B's `PATCH` can only ever affect user B's own current profile — A's
   version/id are confirmed unchanged afterward.

**`test/inbox.test.ts`** — INB-01's specific requirements, plus a
from-scratch isolation check for these routes (same reasoning as above —
Package 2/3's coverage doesn't extend to routes they never exercised):

1. Text and form submissions each create the right channel/payload.
2. **Structural symmetry**: a text event and a form event are asserted to
   have the exact same top-level field set (`Object.keys(...).sort()`
   equality) — not just that each route works in isolation. This is the
   test that would actually catch text and form quietly diverging into
   different shapes.
3. Empty/invalid submissions are rejected on both routes (missing text,
   an entirely empty form, an out-of-range `hungerLevel`).
4. `GET /api/inbox` returns only the caller's own events (proven by giving
   user B exactly one event and confirming user A's much larger history
   never appears in B's list, and vice versa), most-recent-first, with
   working `limit`/`offset` pagination.

**`test/extraction.test.ts`** — the pipeline's ordering property directly,
plus isolation for `/process` and `/follow-up-answer`. The safety-flag
test doesn't call the LLM (it short-circuits before that point); the
normal-entry and follow-up tests make real Anthropic API calls, same as
`packages/eval-harness`.

1. A crisis-language entry produces exactly one `SafetyEvent` (queried
   directly via `db`, since there's no `GET /api/safety-events` route in
   this package), the InboxEvent's status becomes `safety_flagged`, and
   zero `Observation` rows exist for that InboxEvent.
2. A normal entry produces `Observation`s with `verificationState:
   "proposed"`, the right `sourceInboxEventId`, and a plausible
   `confidenceLevel` (a precisely stated weight is asserted `measured`).
3. Cross-account isolation: B cannot process or answer a follow-up on A's
   InboxEvent (`404`); A can still process it normally afterward.
4. **At most one follow-up, ever** — tested by calling
   `extractObservations()` directly: once without an answer (confirming
   `followUpQuestion` is a single string or `null`, structurally never a
   list), then again *with* an answer on the same ambiguous text,
   asserting `followUpQuestion` is `null` — the code-level enforcement in
   `extraction.ts`, not a hope about model behavior.

**`test/observations.test.ts`** — INB-07, seeding Observations directly via
`db` rather than through the pipeline (deterministic, doesn't burn an LLM
call just to get a row to confirm/correct against):

1. Confirm sets `verificationState` to `confirmed` with no new row.
2. Correct creates a new row (new id, `verificationState: "confirmed"`,
   `supersedesObservationId` set, `correctionReason` stored); the old
   row's `isSuperseded` becomes `true` and its value is unchanged; the
   default `GET /api/observations` excludes it while
   `?includeSuperseded=true` includes both.
3. Correcting an already-superseded row is rejected (`409`).
4. Cross-account isolation: B cannot confirm, correct, or list A's
   observations; A's row is confirmed untouched by B's failed attempts.

**`test/voice.test.ts`** — the voice channel, with transcription stubbed
via a test-only escape hatch in `routes/voice.ts`
(`mockTranscriptText`/`mockTranscriptFailure` form fields, gated to
`NODE_ENV === "test"`, same pattern as `/api/_test/login-as`) and audio
storage using the local-filesystem stub — everything downstream of "we
have transcript text" is the real code path, including real Anthropic
extraction calls:

1. **Parity**: a voice upload with a mocked transcript and an equivalent
   `POST /api/inbox/text` call are asserted to reach the same pipeline
   outcome, and when both process normally, their Observations have an
   identical top-level field set (Package 4's structural-symmetry
   principle, extended to voice) and both extract a `"measured"` weight
   from the same precisely-stated figure.
2. Default: audio is deleted (`SourceArtifact.retentionState: "deleted"`,
   `GET .../audio` → `410`) after successful processing.
3. `keep=true` prevents deletion; the audio stays fetchable.
4. A simulated transcription failure sets `transcription_failed` and does
   **not** delete the audio.
5. A safety-flagged voice transcript short-circuits exactly like text —
   `safety_flagged`, one `SafetyEvent`, zero `Observation` rows — reusing
   Package 5's `runPipeline()` guarantee rather than re-implementing it.
6. Cross-account isolation: B cannot fetch A's audio by its InboxEvent id
   (`404`); an upload with no file is rejected (`400`); unauthenticated
   requests to both voice routes are rejected (`401`).

**`test/timeline.test.ts`** — seeds `observations`/`inboxEvents` directly
via `db` rather than through extraction (this package's own logic is the
grouping/join/response-shape work, not extraction quality, so there's no
reason to spend real LLM calls testing it):

1. **The critical one**: a normal observation, an explicit non-event, and
   a no-entry day, requested together in one `GET /api/timeline` call,
   asserted distinguishable from each other in that single response —
   not three separate tests that could each pass while the actual
   distinction silently broke.
2. Provenance: `channel` correctly resolves to `"text"`/`"form"`/`"voice"`
   per the seeded source `InboxEvent`, and `null` for a manually-corrected
   row with no source event.
3. Correction lineage: a corrected observation shows `isCorrection: true`
   and the right `supersedesObservationId`; the default view excludes the
   superseded original while `?includeSuperseded=true` includes both, and
   the original's own `isCorrection` is `false`.
4. Date-range boundaries: observations exactly on `from` and `to` are
   included; one day before `from` and one day after `to` are not; the
   response's `days` array covers exactly `[from, ..., to]`.
5. Default range is 30 days; malformed dates, an inverted range
   (`from` after `to`), and a malformed `:date` path param are all
   rejected with `400`.
6. Cross-account isolation on both routes; unauthenticated rejection.

**How sessions are established in tests, and why:** a real browser-driven
Replit OIDC login can't be automated in CI — there's no way to script a
human clicking "Allow" on replit.com. So every test file uses a test-only
route, `POST /api/_test/login-as` (`routes/testAuth.ts`), which calls
Passport's `req.login()` directly — the exact same call the real OIDC
callback makes — to establish a genuine session. That route is **only
mounted when `NODE_ENV === "test"`** (checked in `app.ts`); it does not
exist in dev or production. Everything downstream of "there's a verified
session" (`resolveAppUser`, `requireConsent`, `attachScopedData`, every
route) is exercised via the real production code path — the shortcut is
strictly limited to skipping the OIDC handshake itself.

**Proof the isolation checks can actually fail, not just pass (Package 2):**
during that package's development, the `userId` filter was temporarily
stripped out of `scopedDataAccess.ts`'s `findById`/`update`/`remove`
(simulating the ACC-02 middleware being missing or broken) and the suite
was re-run. The cross-account test failed immediately and specifically:

```
✖ cross-account isolation: B cannot read, update, or delete A's profile
  AssertionError [ERR_ASSERTION]: B reading A's profile must fail
  200 !== 404
```

The change was then reverted and the suite re-run to confirm a clean pass.
No broken state was committed — this was a one-time, throwaway
demonstration that the test is discriminating, not decorative.

**Same proof for the safety short-circuit (Package 5):** the safety-screen
check in `pipeline.ts` (`if (screen.flagged)`) was temporarily replaced
with `if (false && screen.flagged)` and the safety-flag test was re-run
alone. It failed immediately — with the screen bypassed, the pipeline
actually ran extraction on crisis-language text and produced
`needs_followup` instead of short-circuiting to `safety_flagged`:

```
✖ a safety-flagged entry produces a SafetyEvent, safety_flagged status, and zero Observations
  AssertionError [ERR_ASSERTION]
  + actual - expected
  + 'needs_followup'
  - 'safety_flagged'
```

Reverted, typechecked, and the full suite re-run to confirm a clean pass
(26/26). Same reasoning as Package 2's demonstration: this proves the test
would actually catch the safety screen being missing or broken, not just
that it passes today.

## Known limitations

- **Timeline queries fetch all of a user's observations/inboxEvents, then
  filter/join in memory**, same "reuse `list()`, don't add a new query
  method" tradeoff every package since Package 4 has made. Fine at this
  scale; would need real date-range/JOIN queries at the database level
  before it'd hold up for a user with years of daily logging.
- **Real OIDC login can only be verified on Replit.** The test suites
  deliberately don't exercise `/api/login`/`/api/callback` (see above) —
  someone needs to actually log in via a Repl to confirm the end-to-end
  flow works, per Package 2's definition of done.
- **No profile deletion route.** PRD Section 8.2 doesn't call for deleting
  a baseline profile as part of onboarding, so `scopedDataAccess`'s
  `remove()` capability exists but isn't wired up to any
  `participantProfiles` route. Package 2's old isolation test exercised a
  generic `DELETE /:id` on the placeholder routes; that assertion was
  removed along with the placeholder routes themselves rather than kept
  alive against a capability that no longer exists.
- **No background job queue.** `POST /api/inbox/:id/process` and
  `POST /api/inbox/voice` (Package 6 — upload, transcription, the shared
  pipeline, and the retention decision, all in one request) run entirely
  synchronously. That's fine for proving the pipeline logic, but a real
  queue (so a slow LLM/transcription call doesn't hold a request open, and
  so processing can retry on failure) is future infrastructure this
  package deliberately doesn't build. The closest thing to retry
  infrastructure right now is `scripts/cleanupFailedVoiceUploads.ts`,
  which is a manual/cron script, not a queue — see "Voice channel" above.
- **No retry route for `transcription_failed`.** The audio is retained for
  48 hours specifically to allow a retry, but nothing implements one yet —
  a future package would add something like
  `POST /api/inbox/:id/retry-transcription`.
- **`@replit/object-storage`'s own dependency tree has an unfixed moderate
  `uuid` advisory** (`GHSA-w5hq-g745-h8pq`, via
  `@google-cloud/storage` → `teeny-request`/`gaxios` → `uuid`, "no fix
  available" per `npm audit`). Not something fixable from this package —
  it's Replit's SDK's own transitive dependency choice.
- **Per-entry safety screening (`packages/api/src/inbox/safetyScreen.ts`)
  does not detect rapid weight change**, since that requires a trend
  across multiple observations, not a single entry's text — it's
  structurally out of scope for per-entry screening. Rapid-weight-change
  detection currently only exists in `packages/eval-harness`'s
  weekly-synthesis prototype (Package 0), which isn't wired into the live
  app until Package 9. This means a dangerous single-week change could go
  undetected by the live app for up to a week. Accepted as a known Phase 1
  gap, not blocking — flagged here so it isn't forgotten before a safety
  review.
- **`GET /api/safety-events` doesn't exist.** `test/extraction.test.ts`
  confirms `SafetyEvent` rows directly via `db` rather than through a
  route, since this package wasn't asked to expose one.
