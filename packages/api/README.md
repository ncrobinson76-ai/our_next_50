# api

Packages 2 and 3 of "Our Next 50".

**Package 2** built authentication, session handling, consent capture, and
server-side row-level authorization — entirely about "who is this request
from, and can they only ever touch their own data." No inbox/synthesis/
experiment features.

**Package 3** built on top of that: the real ParticipantProfile baseline
onboarding flow (PRD Section 8.2), replacing Package 2's placeholder
`participantProfiles` CRUD-by-id routes (that package's README explicitly
flagged them as minimal wiring for "a future package" to properly own).

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

**How sessions are established in tests, and why:** a real browser-driven
Replit OIDC login can't be automated in CI — there's no way to script a
human clicking "Allow" on replit.com. So both test files use a test-only
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

## Known limitations

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
