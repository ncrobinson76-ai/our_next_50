import { Router } from "express";

// Public, unauthenticated — this is what confirms the server is up on
// Replit (and locally). No user data, no auth required.
export const healthRouter = Router();

healthRouter.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
