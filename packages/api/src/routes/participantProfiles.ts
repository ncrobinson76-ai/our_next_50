import express, { Router } from "express";
import { fromDbRow, toDbInsert, toInputShape } from "../participantProfile/mapping";
import { parseCreateInput, parseEditInput } from "../participantProfile/validation";

// Package 3: the real ParticipantProfile onboarding/versioning routes,
// superseding Package 2's placeholder CRUD-by-id wiring (that package's
// own README flagged those routes as minimal, "a future package's job" —
// this is that package). Every handler goes through req.data
// (ACC-02); none of them touch the db/participantProfiles table directly.
//
// These are self-service routes: there is no id parameter for reading the
// current profile or editing it — a request always operates on the
// caller's own profile, derived from req.appUser via req.data. That
// removes an entire class of cross-account bugs by construction (there's
// no id to forget to scope). GET /:id (a specific historical version) is
// the one route that does take an id, for callers that already know a
// version's row id; it goes through the same scoped findById as every
// other package.
export const participantProfilesRouter = Router();

participantProfilesRouter.post("/api/participant-profiles", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const existing = await req.data.participantProfiles.list();
  if (existing.length > 0) {
    res.status(409).json({ error: "profile_already_exists", message: "Use PATCH /api/participant-profiles/current to edit." });
    return;
  }

  const parsed = parseCreateInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }

  const created = await req.data.participantProfiles.create(toDbInsert(parsed.value, 1));
  res.status(201).json(fromDbRow(created));
});

participantProfilesRouter.get("/api/participant-profiles/current", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const rows = await req.data.participantProfiles.list();
  if (rows.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const latest = rows.reduce((max, row) => (row.version > max.version ? row : max));
  res.json(fromDbRow(latest));
});

participantProfilesRouter.get("/api/participant-profiles/versions", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const rows = await req.data.participantProfiles.list();
  const sorted = [...rows].sort((a, b) => a.version - b.version);
  res.json(sorted.map(fromDbRow));
});

participantProfilesRouter.patch("/api/participant-profiles/current", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const rows = await req.data.participantProfiles.list();
  if (rows.length === 0) {
    res.status(404).json({ error: "not_found", message: "No profile yet — POST /api/participant-profiles first." });
    return;
  }
  const latest = rows.reduce((max, row) => (row.version > max.version ? row : max));

  const editParsed = parseEditInput(req.body);
  if (!editParsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: editParsed.errors });
    return;
  }

  // Merge the edit onto the current version, then re-validate the merged
  // whole with the same rules as initial creation — a partial edit can
  // never produce a version that's missing a field the profile requires
  // overall.
  const merged = { ...toInputShape(latest), ...editParsed.value };
  const mergedParsed = parseCreateInput(merged);
  if (!mergedParsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: mergedParsed.errors });
    return;
  }

  // A new row, never a mutation of `latest` — old versions are retained.
  const created = await req.data.participantProfiles.create(toDbInsert(mergedParsed.value, latest.version + 1));
  res.json(fromDbRow(created));
});

participantProfilesRouter.get("/api/participant-profiles/:id", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const row = await req.data.participantProfiles.findById(req.params.id);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(fromDbRow(row));
});
