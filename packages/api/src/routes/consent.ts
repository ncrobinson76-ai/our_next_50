import express, { Router } from "express";
import { eq } from "drizzle-orm";
import { db, users } from "../db";
import { CURRENT_CONSENT_VERSION, getCurrentConsentDocument } from "../consent";

// ACC-03. Mounted after resolveAppUser but BEFORE requireConsent, so a
// user who hasn't consented yet can still see and accept the document.
export const consentRouter = Router();

consentRouter.get("/api/consent", (req, res) => {
  res.json({
    ...getCurrentConsentDocument(),
    accepted: req.appUser?.consentVersion === CURRENT_CONSENT_VERSION,
  });
});

consentRouter.post("/api/consent/accept", express.json(), async (req, res) => {
  if (!req.appUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const { version } = req.body ?? {};
  if (version !== CURRENT_CONSENT_VERSION) {
    res.status(400).json({
      error: "version_mismatch",
      currentVersion: CURRENT_CONSENT_VERSION,
    });
    return;
  }

  const updated = await db
    .update(users)
    .set({ consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: new Date() })
    .where(eq(users.id, req.appUser.id))
    .returning();

  res.json({ accepted: true, user: updated[0] });
});
