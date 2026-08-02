import type { RequestHandler } from "express";
import { createScopedDataAccess } from "../data/scopedDataAccess";

// ACC-02: must run after resolveAppUser. Everything downstream gets
// req.data instead of any handle on the raw db/tables.
export const attachScopedData: RequestHandler = (req, res, next) => {
  if (!req.appUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  req.data = createScopedDataAccess(req.appUser.id);
  next();
};
