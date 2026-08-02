import { Router } from "express";
import { toWeeklyReviewResponse } from "../weeklyReview/mapping";

// Read-only access to a user's own generated WeeklyReviews — both routes
// go through req.data.weeklyReviews (ACC-02), same as every other
// user-owned table in this codebase.
export const weeklyReviewsRouter = Router();

weeklyReviewsRouter.get("/api/weekly-reviews", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const rows = await req.data.weeklyReviews.list();
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  res.json({ weeklyReviews: sorted.map(toWeeklyReviewResponse) });
});

weeklyReviewsRouter.get("/api/weekly-reviews/:id", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const row = await req.data.weeklyReviews.findById(req.params.id);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(toWeeklyReviewResponse(row));
});
