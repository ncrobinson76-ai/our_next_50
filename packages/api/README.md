# api

Packages 2 through 8 of "Our Next 50".

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

**Package 8** hardened the safety screen Package 5 built and Package 6 has
been running unmodified since (`src/inbox/safetyScreen.ts`): deeper
keyword coverage on the original three categories, two new categories PRD
Section 10 names (pregnancy-related content, extreme restriction/
over-exercise), and the rapid-weight-change gap explicitly left open since
Package 6 is now closed. Detection logic only — the pipeline's control
flow from Package 5 (screen-before-extraction, hard short-circuit) is
untouched. See "Safety screening" below, **especially the "Known
limitations, for clinical/legal review" section**, which exists
specifically to be handed to a human reviewer.

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
   Started (Package 5) as a port of `packages/eval-harness/safetyCheck.ts`'s
   keyword lists, adapted from a full week's evidence packet to one
   InboxEvent's text; hardened in Package 8 (see "Safety screening" below
   for the full detail) to five categories: `urgent_symptom`,
   `crisis_language`, `disordered_eating`, `pregnancy_related`,
   `extreme_restriction` (matching `packages/db`'s
   `safetyPolicyCategoryEnum` naming directly, since this module writes
   real `SafetyEvent` rows). If flagged: a `SafetyEvent` row is written
   per matched category (category + pathway key + a reference to the
   InboxEvent — **never** the flagged text itself, per PRD Section 11 and
   this table's design from Package 1), the InboxEvent's status becomes
   `safety_flagged`, and the pipeline stops — no LLM call is ever made,
   mirroring the short-circuit pattern already proven in Package 0's
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
5. **Rapid-weight-change check (Package 8), a second independent
   short-circuit point.** Unlike step 1, this is a *computed* check, not
   text matching — it can only run once extraction has produced a
   candidate weight value, so it happens here, right before Observations
   are written. If flagged: same `SafetyEvent` + `safety_flagged` +
   zero-Observations pattern as step 1, just triggered later in the same
   pipeline run. See "Safety screening" below.
6. **No follow-up, not flagged**: Observations are written directly and
   status becomes `processed`.

## Safety screening (`src/inbox/safetyScreen.ts`) — Package 8 hardening

Package 8's whole job was making the screen itself more capable — **the
pipeline's control flow above (screen-before-extraction, hard
short-circuit) is completely untouched.** Five categories now, up from
three:

| Category | How it's detected | Since |
| --- | --- | --- |
| `urgent_symptom` | keyword match on the entry's text | Package 5 |
| `crisis_language` | keyword match | Package 5 |
| `disordered_eating` | keyword match | Package 5 |
| `pregnancy_related` | keyword match | **Package 8** |
| `extreme_restriction` | keyword match | **Package 8** |
| `rapid_weight_change` | computed comparison, not text | **Package 8** |

### Expanded keyword coverage on the original three categories

Per this package's spec: not padded arbitrarily. Every addition was
cross-checked against the actual text in
`packages/eval-harness/scenarios/` for phrasings the original lists would
have missed, and every addition has an inline comment in
`safetyScreen.ts` explaining why. The one concrete gap the cross-check
surfaced: `possible-disordered-eating-language.json`'s per-day
`freeTextNotes` field "Trying to make up for Tuesday still" — read as its
**own** InboxEvent in the real per-entry pipeline (unlike eval-harness's
whole-week packet, which screens all of a week's text as one block) — matched
none of the original keywords, even though the same scenario's full weekly
reflection text ("binged", "don't deserve to eat") did. That's a real
difference between the per-entry model this app runs on and the
whole-week model eval-harness was originally built to evaluate, not
something eval-harness's own test suite could ever surface on its own.
The rest of the additions are proactive (the eval-harness scenario library
only has one example scenario per category, which doesn't exercise the
realistic range of real phrasing) — see `safetyScreen.ts`'s comments for
the reasoning behind each one.

### Two new categories PRD Section 10 names

- **`pregnancy_related`** — a weight-management app giving restriction/
  exercise-intensity advice to someone who may be pregnant is a distinct
  risk, not a variant of `disordered_eating` or `other`. Scoped narrowly
  to pregnancy/trying-to-conceive language (not breastfeeding/postpartum)
  to match the PRD's exact framing rather than quietly expanding it.
- **`extreme_restriction`** — compulsive/rule-bound exercise or caloric
  restriction, framed as compulsion rather than eating-disorder-specific
  language. Deliberately calibrated against
  `very-high-hunger-unwise-to-restrict.json`, an eval-harness scenario
  built specifically to test *restraint*, not trigger a safety
  short-circuit (someone training hard, considering "cutting my portions
  down" because hunger is intense) — none of this category's keywords
  match that scenario's text; ordinary portion-control language and
  dedicated athletic training are deliberately out of scope. The bar is
  genuinely compulsive/rigid framing, not high effort or normal
  calorie-consciousness. `test/safetyHardening.test.ts` runs that
  scenario's exact text as a negative/calibration test.

### `rapid_weight_change` — closing the Package 6 gap

A computed comparison, not text matching: when extraction proposes a
`weight` Observation, `checkRapidWeightChange()` compares it against the
user's own most recent prior (non-superseded) weight Observation, as a
fraction of their `ParticipantProfile`'s starting weight — same 2%
threshold and same formula shape as `packages/eval-harness`'s Package 0
prototype (`|Δweight| / startingWeight`), adapted from "first vs. last
logged weight within a week" to "new value vs. most recent prior value."
Unit-converts kg/lb so a mismatched scale unit between entries can't
produce a false negative. Skips the check (never flags) when there's no
`ParticipantProfile` on file, no starting weight, or no prior weight
Observation to compare against — there's nothing to compute a rapid
*change* from without a "before" point.

### False positives: gentler wording, not cleverer regex

Keyword matching will always have false positives (idiomatic language
like "I could just die of embarrassment") and this package doesn't chase
that with regex — per its own instructions, that's a rabbit hole. Instead,
`crisis_language` and `disordered_eating`'s pathway messages (specifically
those two — not the other three, see the reasoning below) were rewritten
to be gentle about the possibility of a false trigger without undermining
a true positive: the protective content (crisis line, "please reach out")
comes first and stays unconditional, the false-positive acknowledgment is
clearly subordinate, and `crisis_language`'s message closes by explicitly
telling the user not to let a possible misunderstanding stop them from
reaching out if any part of it was real. `test/safetyHardening.test.ts`
asserts both messages still contain real protective content (a crisis
line number, a pointer to a doctor/therapist) and don't lead with an
apology.

**Honest flag, as invited by this package's own instructions**: this is a
real, unresolved tension, and I'm not fully confident the wording fully
threads it. A person in genuine crisis who reads "if I've misunderstood…"
before finishing the message could, in principle, disengage before
reaching the part that tells them not to. I made a judgment call
(protective content first, unconditionally; softening clearly
subordinate and last) but this is exactly the kind of wording a clinical
reviewer should read closely and may want to revise. `urgent_symptom`,
`pregnancy_related`, `extreme_restriction`, and `rapid_weight_change`
weren't given this treatment — the task scoped it to `crisis_language`/
`disordered_eating` specifically, and I didn't extend it further on my
own judgment.

One more honest gap: the crisis_language message references being able to
send a "follow-up describing what you actually meant" to return to normal
processing — that's real (submit a new `/api/inbox/text` entry, which
gets screened fresh), but there's no *dedicated* "that was a false
positive" affordance or route. The message points at an existing,
general-purpose mechanism, not a purpose-built one. A future package
building the actual UX around this might want something more direct.

### Known limitations, for clinical/legal review

This section exists to be handed to a human reviewer. It is written to be
maximally honest, not reassuring:

- **This is keyword-based pattern matching, not a clinical screening
  tool.** It has not been designed, validated, or reviewed by a licensed
  mental health professional or eating-disorder specialist. Nothing about
  its existence should be read as a clinical judgment about any user.
- **It will have false negatives** — real risk language it will not
  catch, because it doesn't understand meaning, only substring matches
  against a finite, human-written list. Anyone can phrase something this
  screen is supposed to catch in a way that isn't on the list.
- **It will have false positives** — ordinary, non-concerning language
  that happens to match a keyword. The wording changes in this package
  soften the user-facing impact of a false positive but do not reduce how
  often one happens.
- **`rapid_weight_change` only looks at this user's own history**, not
  population norms, medical context, or plausible causes (illness,
  medication changes, measurement error, a different scale). It cannot
  distinguish a clinically significant change from a benign one — it
  purely detects "logged value moved a lot since the last one."
- **None of this has been load- or adversarially-tested** against
  attempts to phrase risk language so as to avoid detection, or against a
  large, realistic corpus of real user text. The eval-harness scenario
  library this package's cross-check drew from is 16 hand-written
  fictional examples, not real user data.
- **The two new categories (`pregnancy_related`, `extreme_restriction`)
  are new in this package** and have had zero real-world exposure. Their
  keyword lists and pathway messages are this package's best first attempt,
  not a validated clinical instrument.
- **This system cannot take any action beyond showing a message and
  pausing normal processing.** It cannot contact anyone, cannot verify a
  user is safe, and cannot distinguish "user read the message and is
  fine" from "user never saw the message."

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

## Weekly synthesis (`src/weeklyReview/`) — Package 9

The first time real (not fictional) user data reaches an LLM-generated
weekly review. Everything upstream of "I have an EvidencePacket" — the
system prompt, the Anthropic call, response parsing, and the safety check
that runs before either — now lives in `packages/synthesis-core`, shared
unmodified with `packages/eval-harness`. See that package's README for the
full story of the refactor; this section covers what's specific to this
package: building a real `EvidencePacket` from Postgres data, the
weekly-level safety gate, and persistence.

### `programWeek.ts` — finding the current week

A user's "program start date" is anchored to their **version-1**
`ParticipantProfile`'s `startingWeightDate` — deliberately not the latest
version's, so a later correction to that field can't retroactively shift
which 7-day windows every past `ProgramWeek` belongs to. Per this
package's spec, the window itself is a simple 7-day calendar block from
that anchor date — no missed-week recovery logic (that's explicitly
Package 10's job). `getOrCreateCurrentProgramWeek()` finds-or-creates the
`ProgramWeek` row for whatever window contains today.

### `evidencePacket.ts` — real data into a fixed shape

This is the most involved mapping in the package: real Observations have 11
polymorphic types and free-form `structuredDetails` (no fixed schema — see
`src/inbox/extraction.ts`); the shared `EvidencePacket`/`Observation` shape
was hand-authored in Package 0 against a much simpler fictional day-summary
model. Two decisions worth calling out (both documented at length in the
file itself):

1. **Confirmed vs. proposed (PRD Section 8.4).** The shared `Observation`
   type has no confidence field of its own, so the distinction is encoded
   structurally instead: confirmed/corrected Observations populate
   structured fields (`weight`, `sleep`, `meals`, `hunger`, `activity`,
   `symptoms`, and — for `context_reflection` — the packet's top-level
   `weeklyReflection`). A **proposed** Observation of any type never
   populates a structured field; it's always folded into that day's
   `freeTextNotes` as an explicitly hedged sentence ("An unconfirmed entry
   suggests…"). Derived metrics (weight trend, average sleep/hunger) are
   computed only from the structured fields, so they're confirmed-data-only
   by construction. `test/weeklyReview.test.ts` asserts this directly
   against `assembleEvidencePacket()` — no LLM involved, fully
   deterministic.
2. **Four types with no dedicated field** (`waist`, `energy`,
   `experiment_completion`, `non_scale_win` — the shared `Observation` type
   predates them). Confirmed rows of these types are surfaced as plain
   factual sentences in `freeTextNotes` rather than dropped.
3. **Superseded Observations are excluded entirely**, per the spec.
4. **Medication context**: `onWeightManagementMedication: true` becomes a
   single medication entry whose name states plainly that no drug name or
   dosage was collected — PRD Section 8.2's own scope boundary, not a
   placeholder for a missing feature.
5. **Prior experiment is always `null`.** No `Experiment` entity is wired
   into the API yet (Package 10's job) — passed through gracefully rather
   than fabricated or omitted from the packet shape.

### The weekly-level safety gate (`service.ts`)

Runs `packages/synthesis-core`'s `runSafetyCheck()` against the assembled
weekly packet **before** any call to the synthesis model. This is a
genuinely different, additional check from `src/inbox/safetyScreen.ts`
(Package 5/8): that one only ever sees one entry's text at a time; this one
evaluates a whole week's aggregated evidence at once, including its own
rapid-weight-change comparison (first-vs-last logged weight *within the
week*, distinct from Package 8's newest-vs-most-recent-prior comparison at
entry time). If flagged: a `SafetyEvent` is written per category (mapped
from the shared check's hyphenated category names to the DB's underscored
enum — `urgent-symptom` → `urgent_symptom`, etc.), the synthesis model is
never called, and the route returns the pathway message instead of a
review. `WEEKLY_SAFETY_GATE_VERSION` (`"package-9-weekly-safety-gate-v1"`)
is stored on the `SafetyEvent` row and is a distinct version string from
the per-entry screen's own, so a reviewer can tell which layer flagged a
given entry.

Unlike the per-entry screen, there's no single Observation or InboxEvent
that "caused" a weekly flag — it's a property of the whole packet — so
these `SafetyEvent` rows have no `sourceObservationId`/`sourceInboxEventId`.

### Persistence and routes

- `POST /api/program-weeks/current/generate-review` — the synchronous
  trigger (no job queue, same pattern as Package 5's `.../process` route).
  Finds-or-creates the current `ProgramWeek`, assembles the packet, runs
  the safety gate, then either short-circuits (`200`, `{ status:
  "safety_flagged", pathwayMessage }`) or generates and persists a review
  (`201`, `{ status: "generated", review }`). `409`s if the user has no
  `ParticipantProfile` yet (nothing to build a packet from).
- A generated `WeeklyReview` row records `aiModel`, `promptVersion`
  (`"package-0-synthesis-engine-v1"` — tracks the *prompt's* provenance,
  which hasn't changed since Package 0, not this package's), the structured
  claims, a rendered Markdown report, and `status: "generated"`.
  `weeklyReviewInputObservations` (a many-to-many junction with no
  `userId` column of its own) records every non-superseded Observation
  considered — both confirmed and proposed — as the audit trail for a
  disputed/audited review later. `scopedDataAccess.ts` gives it a narrow,
  ownership-checked accessor (`createMany`/`listObservationIds`, both
  joining back to `weeklyReviews.userId`) rather than the generic
  `UserOwnedTable` pattern, since that pattern requires a `userId` column
  the junction table doesn't have.
- `GET /api/weekly-reviews` / `GET /api/weekly-reviews/:id` — the caller's
  own reviews only, same ACC-02 scoping as every other route.

### Insufficient evidence

No special-case code — this falls out of reusing the shared, unmodified
prompt. A sparse or empty week produces `proposedNextStep.type ===
"insufficient-evidence"` because the same rubric-validated hard rule that
governs eval-harness's `insufficient-evidence` and `missed-two-weeks`
scenarios governs this too. `test/weeklyReview.test.ts` proves it against a
real (zero-Observation) week and a real Anthropic call.

## Experiments and real program-week logic (`src/experiment/`, `src/weeklyReview/programWeek.ts`) — Package 10

Two related things: closing the gap Package 9 explicitly left open
(`evidencePacket.ts`'s `priorExperiment` was hardcoded `null`), and
replacing Package 9's simplified 7-day-window placeholder with real,
sequential program-week logic per PRD Section 8.7.

### Experiment lifecycle (`src/experiment/service.ts`)

When a generated `WeeklyReview`'s `proposedNextStep.type === "experiment"`,
`createExperimentFromSynthesis()` creates a real `Experiment` row from it.

**Mapping gap, worth being explicit about**: this package's spec says to
pull `recommendation`/`rationale`/`target`/`difficulty`/`unchangedBehaviors`
"directly from the synthesis output's own fields... reuse it, don't
reinterpret it." In practice, `packages/synthesis-core/types.ts`'s
`SynthesisOutput` (the Package 0 shape, unmodified since) has no field
literally named `rationale`, and no `target`/`difficulty` field at all —
only `proposedNextStep.description`, `tentativeHypotheses`, and
`whatShouldRemainUnchanged`. Rather than invent values for `target`/
`difficulty` (fields the rubric-validated prompt was never asked to
produce) or quietly extend that prompt/type to add them, this maps what
genuinely exists: `recommendation` <- `proposedNextStep.description`,
`unchangedBehaviors` <- `whatShouldRemainUnchanged` (an exact field-name
correspondence), `rationale` <- `tentativeHypotheses` joined into prose.
`target`/`difficulty` are left `null` — an honest gap, not a fabricated
value, until a future package deliberately extends the prompt to propose
them.

Status transitions (`experimentStatusEnum`: `proposed, accepted, modified,
declined, paused, retired`) are enforced through one table, not scattered
checks:

```
proposed -> accepted | modified | declined
accepted -> paused | retired
modified -> paused | retired
paused   -> retired
declined, retired: terminal
```

- **`/accept`** — sets `startedAt`.
- **`/modify`** — accepts a user-edited recommendation. The `experiments`
  table has no dedicated "original vs. edited" column, so the edit is
  stored by overwriting `recommendation` and appending an audit note to
  `rationale` recording the original text — reusing an existing free-text
  field rather than adding a schema column for this alone.
- **`/decline`**, **`/pause`**, **`/retire`** (retire accepts an optional
  `outcome` in the body).
- **`/log-completion`** — a lightweight completion check-in (`completed`
  boolean + `date` + optional `note`), deliberately separate from full
  Observation logging: no extraction, no LLM call. Writes one Observation
  of type `experiment_completion` directly, with `isExplicitNonEvent`
  encoding "did not do it" (reusing PRD Section 8.4's existing
  explicit-non-event concept rather than inventing a new field), linked via
  the `experimentCompletionObservations` junction. Only allowed while
  `accepted` **or** `modified` — both represent an experiment the user is
  actively engaged with (`isActivelyAccepted()`), even though the spec text
  names only "accepted" literally; the same reading applies to `/pause`/
  `/retire`, which the spec explicitly scopes to "an already-accepted
  experiment" as a general phrase, not a literal single-status check.

Every route rejects an illegal transition with `409 { error:
"illegal_transition", from, to }`, enforced server-side — never inferred
from what a well-behaved client would send. `test/experiment.test.ts`
exercises every illegal transition explicitly (accept-after-decline,
retire-after-retire, modify-after-accept, pause-after-pause,
pause-on-a-still-proposed-experiment), not just the happy path, plus the
standard "prove it would fail without the guard" demonstration (see below).

### `priorExperiment` wired for real (`src/weeklyReview/priorExperiment.ts`)

`findMostRecentEngagedExperiment()` finds the most recent Experiment whose
status is `accepted`/`modified`/`paused`/`retired` (i.e. one the user
actually engaged with — `proposed` and `declined` convey nothing useful as
prior-week context) with `startedAt` before the new week's start date.
`buildPriorExperienceContext()` maps it plus its completion check-ins into
`packages/synthesis-core`'s `PriorExperiment` shape:

- `description` <- `recommendation`, `hypothesis` <- `rationale`,
  `startDate` <- `startedAt`.
- `status`: the DB's 6-value `experimentStatusEnum` collapses onto
  `PriorExperiment`'s coarser 3-value set (`accepted`/`modified` ->
  `"ongoing"`, `paused` -> `"abandoned"`, `retired` -> `"completed"`) — a
  deliberate simplification versus the DB's richer enum, not a 1:1 mirror.
  The raw DB status word is preserved in `outcomeNotes` so nothing is
  actually lost to the coarser bucketing.
- `outcomeNotes` summarizes completion check-ins ("Logged as done on N and
  not done on M of T tracked check-in(s)").

`evidencePacket.ts`'s `assembleEvidencePacket()` now takes `priorExperiment`
as a parameter instead of a hardcoded `null` — a week with no engaged prior
experiment still correctly omits the field, per the shape's existing
optionality, rather than fabricating one.

### Real program-week / missed-time logic (`src/weeklyReview/programWeek.ts`)

`syncProgramWeeksThroughToday()` replaces Package 9's
`getOrCreateCurrentProgramWeek()`. Real sequential 7-day windows from the
user's actual program start date (still anchored to their version-1
profile's `startingWeightDate`, per Package 9), walking every window index
from 0 through today's — not "the last 7 days from today." Per PRD Section
8.7, a week strictly before today's is never left silently unaccounted
for:

- No row at all for that window -> created with `status: "skipped"`.
- A row exists but is still `"scheduled"` (a review was never generated
  for it) -> corrected to `"skipped"` — a lapsed past week reads the same
  as a fully-missed one, whether or not it happened to get a row along the
  way.
- Today's own window -> found or created as `"scheduled"`, then marked
  `"completed"` by `weeklyReview/service.ts` once a review is actually
  generated for it.

**Evidence-sufficiency threshold** (`EVIDENCE_SUFFICIENCY_MIN_LOGGED_DAYS =
3`): made explicit and queryable rather than left implicit in the
synthesis model's own judgment. Derived from `packages/eval-harness`'s own
fixtures, not picked arbitrarily — `insufficient-evidence.json` logs 1 of 7
days and `missed-two-weeks.json` logs 2 of 14, both built to trigger the
prompt's insufficient-evidence path; `missed-day.json` logs 6 of 7 and was
built to get normal synthesis. 3 sits cleanly between the two, with margin
on both sides. Computed twice per current week: a quick pre-check during
sync (before any packet exists), then refined using the packet's own
authoritative `loggedDayCount` once a review is actually generated for it
— the same threshold function both times, just applied to increasingly
precise data.

**`GET /api/program-weeks`** — the user's own program history
(`weekStartDate`, `status`, `evidenceSufficient`), sorted chronologically,
so a future UI (Package 11) can show gaps honestly. Deliberately read-only:
it does **not** trigger `syncProgramWeeksThroughToday`, so a user who has
never called `generate-review` sees an empty list rather than this `GET`
silently creating rows as a side effect.

## Progress, Privacy, Export, and Account Deletion — Package 11

Three read surfaces built entirely from data that already exists (no new
tables beyond one deletion-flow table, no new AI calls), plus real
irreversible-action deletion. Still API routes, no frontend framework.

### `GET /api/progress` (`src/progress/service.ts`) — Part A

A factual rollup, deliberately distinct from the synthesis engine: no LLM
call, no new interpretation. The weight trend specifically reuses
`weeklyReview/evidencePacket.ts`'s `isTrusted()` (now exported) and
`packages/synthesis-core`'s `computeWeightTrend()` rather than re-deriving
a parallel "which observations count as real" rule — the full-program
series is built the same confirmed-only way a single week's packet is, just
over every day instead of seven. Program-week reporting surfaces `skipped`
weeks explicitly (`skippedCount`), not just a total — hiding that would be
exactly the "track less, learn more" (PRD Section 5) violation this
package's own spec called out. Experiment history is a per-status tally
plus the currently-active list; non-scale wins are their own first-class
count + list, confirmed-only, same trust rule as everything else here.
Deliberately does **not** call `syncProgramWeeksThroughToday()` — a GET
never has side effects, same rule `GET /api/program-weeks` already
established in Package 10.

### `GET /api/privacy/summary` (`src/privacy/service.ts`) — Part B (ACC-04)

Per-entity-type counts across every user-owned table, current consent
version/date, `SourceArtifact` counts broken out by `retentionState`
(`active`/`pending_deletion`/`deleted`), and `SafetyEvent` counts **by
category only** — consistent with Package 2's ACC-05 safe-logging rule.
This table has no content field to store in the first place (see
`safetyEvents.ts`), so "category counts, never content" is satisfied by
construction, not by redacting anything.

### `GET /api/export` (`src/export/service.ts`) — Part C (ACC-04)

A single complete JSON document. `export/service.ts`'s header comment
cross-checks every table in `packages/db/src/schema/index.ts` and states
an include/exclude reason for each — `sessions` (connect-pg-simple
infrastructure) and `auditEvents` (a system security record, not
user-facing personal data, and not reliably attributable to one user once
`SET NULL` has run) are the only exclusions; everything else is included.
Junction tables (`weeklyReviewInputObservations`,
`experimentCompletionObservations`) aren't exported as flat arrays —
they're folded into `inputObservationIds`/`completionObservationIds` on
their parent `weeklyReviews`/`experiments` entries instead, which is more
useful than a disconnected list of id pairs. `observations` includes
superseded rows, explicitly marked via the existing `isSuperseded` field —
export is about completeness, not the "current truth only" view other
routes show. `transcripts` includes full text: unlike the Privacy Summary
route, export exists specifically to hand a user everything about
themselves, so the "content vs. category" minimization Part B applies
doesn't apply here.

### Account deletion (`src/account/service.ts`, `routes/account.ts`) — Part D (ACC-04)

The highest-stakes part of this package: real, irreversible, two-step
deletion.

**Two-step confirmation.** `POST /api/account/delete-request` generates a
32-byte random token, stores only its SHA-256 hash (never the raw value),
and returns the raw token to the caller exactly once, with a 15-minute
expiry (`DELETION_TOKEN_TTL_MINUTES`). `POST /api/account/delete-confirm`
must present that same raw token; it's re-hashed and compared against the
stored hash with `crypto.timingSafeEqual` (not `===`, to avoid a timing
side-channel on a token comparison). Only the most recent unexpired
request for the caller's own account is ever considered valid — both
routes act exclusively on `req.appUser.id` from the authenticated session,
**never** a userId taken from the request body, so even a leaked raw token
only lets its holder delete their own account if they're also
authenticated as that account; it cannot be replayed against someone
else's, regardless of who has the token value.

**Deletion order matters.** Object-storage files are deleted *before* the
`users` row, not after: if a storage delete fails partway through, the
whole confirm call fails with `storage_deletion_failed` and the DB is left
completely untouched (retryable), rather than risking a DB-deleted account
with files it can no longer identify or reach. Only once every retained
`SourceArtifact`'s file is confirmed removed does `db.delete(users)` run —
`users` has no `ScopedDataAccess` accessor (it's the scope root, not a
user-owned table), so this is a direct `db` call, the same established
exception `middleware/resolveAppUser.ts` already makes for this one table.

**The cascade itself is Postgres's, not application code's** — every
user-owned table's `ON DELETE CASCADE` (set up per-package since Package
1) does the actual work once the `users` row goes. `test/
accountDeletion.test.ts`'s cascade test seeds one row in every major table
(including a real object-storage file, not a mock) and asserts zero rows
remain in each, specifically to catch a table whose cascade was set up
wrong or forgotten — this is not assumed correct just because the schema
says so.

**SafetyEvents: the deliberate exception, decided explicitly, not
silently.** This package's spec called out a real tension — "the user's
data should be fully deletable" vs. "a safety-incident record may need to
survive for liability/audit reasons" — and explicitly required asking
rather than picking a side unilaterally. Asked, and the answer was:
anonymize and retain. `safetyEvents.ts`'s `userId` column now uses
`ON DELETE SET NULL` instead of `CASCADE` (a new migration,
`drizzle/0007_black_scarecrow.sql`) — mirroring the exact pattern
`auditEvents.ts` already used for `actorUserId`/`subjectUserId` before
this package existed. A `SafetyEvent` row (category + timestamps only —
this table has never stored flagged content) survives account deletion
with no link back to the deleted user, rather than being erased. This is
recorded as a **provisional product decision, not a settled legal one** in
`/OPERATIONS.md` — the pending attorney review that already gates this
app's rollout needs to confirm no jurisdiction's record-retention or
mandatory-reporting rules call for something different before it's
treated as final.

**"Prove it would fail" demonstration.** The token-match check in
`confirmDeletion()` was temporarily commented out and the wrong-token test
re-run alone. It failed immediately — a completely fabricated all-zeros
token successfully deleted the account:

```
✖ delete-confirm with the wrong token is rejected and performs no deletion
  AssertionError [ERR_ASSERTION]
  200 !== 400
```

Reverted, typechecked, and the full suite re-run to confirm a clean pass
(90/90). The SafetyEvent anonymization guarantee itself is enforced by
Postgres's own `ON DELETE SET NULL` constraint, not application code — its
correctness is asserted directly in the cascade test
(`safetyRow.userId === null` after deletion) rather than demonstrated by
disabling and re-enabling a live schema constraint, which felt like an
unnecessary risk to take against a real migration for a demo.

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

**`test/safetyHardening.test.ts`** — Package 8's own tests. Mostly pure
unit tests against `runSafetyScreen()` directly (no server, no DB, no LLM
calls needed for keyword-matching correctness); the rapid-weight-change
section is the exception, seeding a `ParticipantProfile` and prior weight
`Observation` via `db` and running a real pipeline call (same pattern as
`test/extraction.test.ts`):

1. Expanded keyword coverage: a phrase not in the original three
   categories' lists now correctly flags each of them, including the
   concrete gap the eval-harness cross-check found (see "Safety
   screening" above).
2. Both new categories (`pregnancy_related`, `extreme_restriction`) flag
   correctly and produce their own distinct pathway messages.
3. **Calibration**: eval-harness's `very-high-hunger-unwise-to-restrict.json`
   scenario text — deliberately NOT meant to trigger a safety
   short-circuit — is asserted to not flag `extreme_restriction`.
4. **True-positive wording**: the softened `crisis_language`/
   `disordered_eating` messages are asserted to still contain real
   protective content (the 988 crisis line, a pointer to a doctor/
   therapist) and to not lead with an apology/hedge.
5. Rapid-weight-change: a seeded prior weight plus a new entry exceeding
   2% of starting weight short-circuits exactly like the text-based
   categories (`safety_flagged`, one `SafetyEvent` with
   `policyCategory: "rapid_weight_change"`, zero `Observation` rows); a
   normal entry within threshold processes normally.
6. The full existing `test/extraction.test.ts` and `test/voice.test.ts`
   suites (Package 5/6, unmodified) are re-run as part of the same
   `npm test` invocation — confirmed passing, no regressions from this
   package's detection-logic changes.

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

**Same proof again for rapid-weight-change (Package 8):** the check in
`pipeline.ts` (`if (rapidWeightCheck.flagged)`) was temporarily replaced
with `if (false && rapidWeightCheck.flagged)` and the rapid-weight-change
test was re-run alone. It failed immediately — with the check bypassed,
the entry with a 15 lb / 7.5%-of-starting-weight drop processed normally
instead of short-circuiting:

```
✖ rapid weight change short-circuits exactly like the text-based categories
  AssertionError [ERR_ASSERTION]
  + actual - expected
  + 'processed'
  - 'safety_flagged'
```

Reverted, typechecked, and the full suite re-run to confirm a clean pass
(53/53). Same demonstration, third time — this is now the standard this
package holds every safety short-circuit test to.

**Same proof, fourth time, for the weekly-level safety gate (Package 9):**
the check in `weeklyReview/service.ts` (`if (safetyCheck.flagged)`) was
temporarily replaced with `if (false && safetyCheck.flagged)` and the
weekly-safety-gate test was re-run alone. It failed immediately — with the
gate bypassed, a week whose only content was crisis-language text didn't
short-circuit at all: it fell through to a real synthesis call and
persisted an actual `WeeklyReview` row built from that content, returning
`201`/`"generated"` instead of `200`/`"safety_flagged"`:

```
✖ the weekly-level safety gate short-circuits before any synthesis call, and writes a SafetyEvent
  AssertionError [ERR_ASSERTION]: a flagged week is a valid outcome, not an HTTP error
  201 !== 200
```

This is the starkest version of this demonstration in the package so far —
the failure mode isn't a wrong status code on an otherwise-inert request,
it's a real LLM call and a real persisted review generated from
crisis-language content, which is exactly the class of failure this gate
exists to prevent. Reverted, typechecked, and the full suite re-run to
confirm a clean pass (59/59).

**Package 10 adds two more, for the two guarantees its own spec called out
as needing the most care.** First, the illegal-transition guard in
`experiment/service.ts`'s `transition()` — the `if
(!VALID_TRANSITIONS[existing.status].includes(to))` check — was temporarily
commented out and `test/experiment.test.ts`'s illegal-transitions test was
re-run alone. It failed immediately: a `declined` experiment could be
`accept`ed again as if nothing had happened.

```
✖ illegal transitions are rejected server-side, not just skipped in the happy path
  AssertionError [ERR_ASSERTION]
  true !== false
```

Second — the one this package's own spec flagged as the test "worth being
most careful about" — the missed-week backfill loop in
`weeklyReview/programWeek.ts`'s `syncProgramWeeksThroughToday()`
(`for (let index = 0; index <= currentIndex; index++)`) was temporarily
narrowed to only ever touch `currentIndex` (i.e. Package 9's old
jump-straight-to-the-current-week behavior), and the missed-weeks test was
re-run alone. It failed immediately — for a user who'd been gone 3+ weeks,
zero missed `ProgramWeek`s were backfilled instead of the expected 3:

```
✖ a user who skips 2+ weeks gets honest missed ProgramWeek records, not a silent jump to 'current week'
  AssertionError [ERR_ASSERTION]: weeks 0, 1, and 2 must all be backfilled
  0 !== 3
```

Both reverted, typechecked, and the full suite re-run to confirm a clean
pass (78/78).

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
- **Resolved in Package 8**: per-entry safety screening not detecting
  rapid weight change (originally flagged here since Package 6) is now
  closed via a computed comparison against the user's own prior weight
  history — see "Safety screening" above and its "Known limitations, for
  clinical/legal review" subsection for what that check does and doesn't
  account for.
- **`GET /api/safety-events` doesn't exist.** `test/extraction.test.ts`
  confirms `SafetyEvent` rows directly via `db` rather than through a
  route, since this package wasn't asked to expose one.
- **Resolved in Package 10**: missed-week recovery logic (flagged here
  since Package 9) is now closed — `syncProgramWeeksThroughToday()`
  back-fills every missed `ProgramWeek` as `"skipped"` rather than
  silently jumping to the current window. See "Experiments and real
  program-week logic" above.
- **Resolved in Package 10**: the `Experiment` entity (flagged here since
  Package 9) is now wired up — `EvidencePacket.priorExperiment` is
  populated for real when an engaged-with prior experiment exists. See
  "Experiments and real program-week logic" above for the lifecycle and
  the `PriorExperiment.status` mapping's own known simplification.
- **`structuredDetails` has no fixed schema**, so `evidencePacket.ts` reads
  sub-fields like a meal's `approxCalories` or an activity's `intensity`
  opportunistically with a type guard, never fabricating a value that
  isn't there. Since no real extracted data has flowed through this path
  before Package 9, this mapping hasn't been exercised against the actual
  range of shapes the extraction model tends to produce — it's a
  reasonable first attempt, not a validated contract.
- **Medication context is a flag, not a fact.** Per PRD Section 8.2's own
  scope (no drug name or dosage collected), a user on a weight-management
  medication gets one generic medication entry stating plainly that no
  specifics were collected. The synthesis prompt can note that medication
  context affects interpretation in general terms; it cannot reason about
  a *specific* medication's known effects, because it was never told one.
- **Real synthesis output now reaches actual users.** See `/OPERATIONS.md`
  at the repo root for the rollout gate this package's spec requires before
  onboarding anyone beyond founder solo testing.
- **No resume-from-paused transition (Package 10).** An experiment can be
  paused and later retired, but there's no `/resume` route back to
  `accepted`. Not asked for by this package's spec; a real gap if a future
  UI wants to let a user un-pause an experiment rather than only retire it.
- **`Experiment.target` and `Experiment.difficulty` are currently always
  `null`** — `packages/synthesis-core`'s Package 0 output has no
  structured field for either, only a prose description. Populating them
  for real requires extending the rubric-validated synthesis system
  prompt, which requires re-running the full eval-harness scenario suite
  to confirm no regression — not done as part of Package 10, since no
  current UI consumes these fields. Revisit when Package 11 (or later)
  actually needs them.
- **`Experiment.rationale <- tentativeHypotheses.join(" ")` is an
  approximation, not an exact correspondence** — same honesty standard as
  the `target`/`difficulty` note above. `tentativeHypotheses` explains the
  observed *pattern* the synthesis noticed; it doesn't necessarily explain
  why *this specific experiment* was chosen as the response to it.
- **No `GET /api/experiments` or `GET /api/experiments/:id` route.** Every
  lifecycle route (`/accept`, `/modify`, etc.) returns the resulting
  Experiment in its response body, which is what `test/experiment.test.ts`
  relies on — a dedicated list/get route wasn't asked for by this
  package's spec, so none was added.
- **Evidence-sufficiency threshold (3 of 7 logged days) is a single global
  constant**, not tunable per user or adjusted for a user's own typical
  logging cadence. Derived from eval-harness's fixtures (see "Experiments
  and real program-week logic" above), not clinically validated.
- **Backfilled "skipped" weeks don't retroactively affect anything else.**
  A `ProgramWeek` marked `skipped` doesn't trigger a notification and
  doesn't adjust `completedWeekNumber` sequencing. Package 11's Progress
  view surfaces a `skippedCount` (an honest number), but there's still no
  dedicated "you missed 3 weeks" messaging/UX — that's a future package's
  job (there's no frontend framework at all yet), not this one's.
- **`GET /api/progress`'s weight series has no pagination or date-range
  filtering (Package 11).** It returns every trusted, deduplicated-per-day
  weight point across the user's entire program. Fine at this scale (same
  tradeoff every read-all-then-filter-in-memory route in this package has
  made since Package 4); would need a real range query before it'd hold up
  for a user with years of daily logging.
- **No dedicated retry/resume for a failed `POST /api/account/delete-
  confirm` (Package 11).** If object-storage deletion fails partway
  through, the call returns `storage_deletion_failed` and nothing in the
  DB is touched (so the state is safely retryable), but there's no
  automatic retry — the caller has to call `delete-confirm` again with a
  still-valid token, or request a new one if it expired in the meantime.
- **`Experiment.difficulty`/`target` are still always `null` in export
  output too (Package 11)** — the export just reflects
  `toExperimentResponse()`'s existing shape; see the Package 10 note above
  for why those fields are empty.
- **SafetyEvent anonymized-retention-on-deletion is provisional, not
  legally settled (Package 11).** See "Account deletion" above and
  `/OPERATIONS.md` — this needs explicit confirmation during the pending
  attorney review, not just an engineering decision.
