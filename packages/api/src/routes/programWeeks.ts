import { Router } from "express";
import { toWeeklyReviewResponse } from "../weeklyReview/mapping";
import { generateCurrentWeekReview } from "../weeklyReview/service";

// Package 9: the synchronous trigger for the real weekly-synthesis
// pipeline, same "no job queue yet" pattern as Package 5's
// POST /api/inbox/:id/process.
export const programWeeksRouter = Router();

programWeeksRouter.post("/api/program-weeks/current/generate-review", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const result = await generateCurrentWeekReview(req.data);

  if (result.status === "no_profile") {
    res.status(409).json({
      error: "no_participant_profile",
      message: "A participant profile must exist before a weekly review can be generated.",
    });
    return;
  }

  if (result.status === "safety_flagged") {
    // Not an error — the weekly-level safety gate short-circuited normal
    // synthesis, same "flagged is a valid outcome, not a failure" pattern
    // as Package 5/8's per-entry pipeline result.
    res.json({ status: "safety_flagged", pathwayMessage: result.pathwayMessage });
    return;
  }

  res.status(201).json({ status: "generated", review: toWeeklyReviewResponse(result.review) });
});
