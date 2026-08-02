import { Router } from "express";
import { buildPrivacySummary } from "../privacy/service";

// Package 11 Part B (ACC-04): the honest, plain accounting a privacy-
// conscious user should be able to see about themselves at any time —
// counts per entity type, never content. See privacy/service.ts.
export const privacyRouter = Router();

privacyRouter.get("/api/privacy/summary", async (req, res) => {
  if (!req.data || !req.appUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  res.json(await buildPrivacySummary(req.data, req.appUser));
});
