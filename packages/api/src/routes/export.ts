import { Router } from "express";
import { buildFullExport } from "../export/service";

// Package 11 Part C (ACC-04): a complete export of the user's own data as
// a single JSON document. See export/service.ts's header comment for the
// table-by-table completeness cross-check.
export const exportRouter = Router();

exportRouter.get("/api/export", async (req, res) => {
  if (!req.data || !req.appUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  res.json(await buildFullExport(req.data, req.appUser));
});
