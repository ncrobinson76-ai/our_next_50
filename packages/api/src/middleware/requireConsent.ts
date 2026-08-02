import type { RequestHandler } from "express";
import { CURRENT_CONSENT_VERSION } from "../consent";

// ACC-03: blocks every other route until the user has accepted the current
// consent version. Must run after resolveAppUser. The consent routes
// themselves (see routes/consent.ts) are mounted before this middleware so
// a not-yet-consented user can still see and accept the consent document.
export const requireConsent: RequestHandler = (req, res, next) => {
  if (!req.appUser) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  if (req.appUser.consentVersion !== CURRENT_CONSENT_VERSION) {
    res.status(403).json({
      error: "consent_required",
      currentVersion: CURRENT_CONSENT_VERSION,
    });
    return;
  }

  next();
};
