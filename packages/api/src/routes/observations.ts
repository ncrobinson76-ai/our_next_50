import express, { Router } from "express";
import { toObservationResponse } from "../observations/mapping";
import { parseCorrectionInput } from "../observations/validation";

// INB-07: the user acting on their own proposed Observations. All three
// routes go through req.data.observations (ACC-02) — same as every other
// user-owned table in this codebase.
export const observationsRouter = Router();

observationsRouter.post("/api/observations/:id/confirm", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const existing = await req.data.observations.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.isSuperseded) {
    res.status(409).json({ error: "already_superseded", message: "Confirm the current version instead." });
    return;
  }

  // Confirming doesn't change the value, just trust in it — no new row.
  const updated = await req.data.observations.update(req.params.id, { verificationState: "confirmed" });
  res.json(toObservationResponse(updated!));
});

observationsRouter.patch("/api/observations/:id/correct", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const existing = await req.data.observations.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.isSuperseded) {
    res.status(409).json({ error: "already_superseded", message: "Correct the current version instead." });
    return;
  }

  const parsed = parseCorrectionInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }
  const patch = parsed.value;

  // Same versioning idea as Package 3's ParticipantProfile edit flow,
  // applied to a different table: never mutate the old row, insert a new
  // one carrying the merged values, and link the two. `type` never
  // changes via a correction — if the type itself was wrong, that's a
  // different kind of edit this endpoint doesn't attempt.
  const insertValues = {
    type: existing.type,
    observedDate: patch.observedDate ?? existing.observedDate,
    timeOfDay: patch.timeOfDay ?? existing.timeOfDay,
    value: patch.value !== undefined ? String(patch.value) : existing.value,
    unit: patch.unit ?? existing.unit,
    textValue: patch.textValue ?? existing.textValue,
    structuredDetails: patch.structuredDetails ?? existing.structuredDetails,
    isExplicitNonEvent: patch.isExplicitNonEvent ?? existing.isExplicitNonEvent,
    // A user's own correction is authoritative, but that's a statement
    // about *trust* (verificationState), not about *how* the value was
    // obtained — defaults to user_reported (they're telling us directly)
    // unless they explicitly say otherwise (e.g. re-reading a scale gives
    // "measured").
    confidenceLevel: patch.confidenceLevel ?? ("user_reported" as const),
    verificationState: "confirmed" as const,
    // Not sourced from any InboxEvent — this row exists because of a
    // direct user correction via this API, same provenance story as a
    // manually-entered observation.
    sourceInboxEventId: null,
    sourceTranscriptId: null,
    supersedesObservationId: existing.id,
    correctionReason: patch.correctionReason ?? null,
  };
  const created = await req.data.observations.create(insertValues);
  await req.data.observations.update(existing.id, { isSuperseded: true });

  res.status(201).json(toObservationResponse(created));
});

observationsRouter.get("/api/observations", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const includeSuperseded = req.query.includeSuperseded === "true";
  const rows = await req.data.observations.list();
  const filtered = includeSuperseded ? rows : rows.filter((row) => !row.isSuperseded);
  const sorted = [...filtered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  res.json({ observations: sorted.map(toObservationResponse) });
});
