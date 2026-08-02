import { Router } from "express";
import { toProgramWeekResponse } from "../weeklyReview/programWeekMapping";
import { toWeeklyReviewResponse } from "../weeklyReview/mapping";
import { generateCurrentWeekReview } from "../weeklyReview/service";

// Package 9: the synchronous trigger for the real weekly-synthesis
// pipeline, same "no job queue yet" pattern as Package 5's
// POST /api/inbox/:id/process.
export const programWeeksRouter = Router();

// Package 10 (PRD Section 8.7): the user's own program history, honestly
// including gaps ("skipped" weeks) — for a future UI (Package 11). Purely
// read-only: it does NOT trigger syncProgramWeeksThroughToday, so a user
// who has never called generate-review sees an empty list rather than
// this GET silently creating rows as a side effect.
programWeeksRouter.get("/api/program-weeks", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const rows = await req.data.programWeeks.list();
  const sorted = [...rows].sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
  res.json({ programWeeks: sorted.map(toProgramWeekResponse) });
});

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
