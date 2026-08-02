import express, { Router } from "express";

// Minimal wiring, deliberately not full versioning semantics — this
// package's job is proving the auth/isolation pattern, not the real
// ParticipantProfile business logic (a future package owns that). Every
// handler goes through req.data.participantProfiles (ACC-02); none of them
// touch the db/participantProfiles table directly.
export const participantProfilesRouter = Router();

participantProfilesRouter.post("/api/participant-profiles", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const created = await req.data.participantProfiles.create(req.body);
  res.status(201).json(created);
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
  res.json(row);
});

participantProfilesRouter.patch("/api/participant-profiles/:id", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const updated = await req.data.participantProfiles.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

participantProfilesRouter.delete("/api/participant-profiles/:id", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const removed = await req.data.participantProfiles.remove(req.params.id);
  if (!removed) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(removed);
});
