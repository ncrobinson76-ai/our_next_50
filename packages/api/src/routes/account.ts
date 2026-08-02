import express, { Router } from "express";
import { confirmDeletion, createDeletionRequest } from "../account/service";

// Package 11 Part D (ACC-04): irreversible account deletion, gated behind
// a two-step confirmation — never a single-call hard delete. Both routes
// always act on req.appUser.id (the authenticated caller's own session),
// never on a userId taken from the request body — so even a leaked token
// only ever lets its holder delete their OWN account if they're also
// authenticated as that account; it can't be used to delete someone
// else's, regardless of who possesses the raw token value.
export const accountRouter = Router();

accountRouter.post("/api/account/delete-request", async (req, res) => {
  if (!req.data) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const result = await createDeletionRequest(req.data);
  res.status(201).json({
    token: result.token,
    expiresAt: result.expiresAt,
    message: "Present this token to POST /api/account/delete-confirm to permanently delete your account. This action cannot be undone.",
  });
});

accountRouter.post("/api/account/delete-confirm", express.json(), async (req, res) => {
  if (!req.data || !req.appUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const token = req.body?.token;
  if (typeof token !== "string" || token.length === 0) {
    res.status(400).json({ error: "validation_failed", errors: ["token is required"] });
    return;
  }

  const result = await confirmDeletion(req.data, req.appUser.id, token);

  if (!result.ok) {
    if (result.reason === "no_pending_request" || result.reason === "invalid_or_expired_token") {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.status(500).json({ error: result.reason, message: result.message });
    return;
  }

  res.json({ status: "deleted" });
});
