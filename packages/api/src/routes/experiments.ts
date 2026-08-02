import express, { Router } from "express";
import { toExperimentResponse } from "../experiment/mapping";
import {
  acceptExperiment,
  declineExperiment,
  logCompletion,
  modifyExperiment,
  pauseExperiment,
  retireExperiment,
  type TransitionResult,
} from "../experiment/service";
import { parseLogCompletionInput, parseModifyInput, parseRetireInput } from "../experiment/validation";

// Package 10: the user acting on their own proposed/accepted Experiments.
// All routes go through req.data.experiments (ACC-02), same as every
// other user-owned table in this codebase. Only legal status transitions
// are allowed — see experiment/service.ts's VALID_TRANSITIONS — enforced
// server-side and reported as a 409, not silently accepted or ignored.
export const experimentsRouter = Router();

function respondToTransition(res: express.Response, result: TransitionResult): void {
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(409).json({ error: "illegal_transition", from: result.from, to: result.to });
    return;
  }
  res.json(toExperimentResponse(result.experiment));
}

experimentsRouter.post("/api/experiments/:id/accept", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  respondToTransition(res, await acceptExperiment(req.data, req.params.id));
});

experimentsRouter.post("/api/experiments/:id/modify", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = parseModifyInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }

  const result = await modifyExperiment(req.data, req.params.id, parsed.value.recommendation);
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(409).json({ error: "illegal_transition", from: result.from, to: result.to });
    return;
  }
  res.json(toExperimentResponse(result.experiment));
});

experimentsRouter.post("/api/experiments/:id/decline", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  respondToTransition(res, await declineExperiment(req.data, req.params.id));
});

experimentsRouter.post("/api/experiments/:id/pause", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  respondToTransition(res, await pauseExperiment(req.data, req.params.id));
});

experimentsRouter.post("/api/experiments/:id/retire", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = parseRetireInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }
  respondToTransition(res, await retireExperiment(req.data, req.params.id, parsed.value.outcome));
});

experimentsRouter.post("/api/experiments/:id/log-completion", express.json(), async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = parseLogCompletionInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", errors: parsed.errors });
    return;
  }

  const result = await logCompletion(req.data, req.params.id, parsed.value);
  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(409).json({ error: "not_active", status: result.status });
    return;
  }
  res.status(201).json({ observationId: result.observationId });
});
