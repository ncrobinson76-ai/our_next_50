import { Router } from "express";
import { buildProgressSummary } from "../progress/service";

// Package 11 Part A: a single read-only rollup of the user's own journey
// so far. No LLM call, no new writes — see progress/service.ts.
export const progressRouter = Router();

progressRouter.get("/api/progress", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  res.json(await buildProgressSummary(req.data));
});
