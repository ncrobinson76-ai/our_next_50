import express, { Router } from "express";

// TEST-ONLY. Establishes a real session via req.login() — the exact same
// Passport session-establishment call the real OIDC callback uses — so
// the isolation test suite exercises the genuine downstream auth/session
// path (resolveAppUser, requireConsent, attachScopedData) without needing
// a live browser OAuth round-trip against replit.com, which no automated
// test can drive. Only mounted when NODE_ENV === "test" (see app.ts) —
// never present in dev or production.
export const testAuthRouter = Router();

testAuthRouter.post("/api/_test/login-as", express.json(), (req, res) => {
  const { authProviderId, email } = req.body ?? {};
  if (!authProviderId || !email) {
    res.status(400).json({ error: "authProviderId and email are required" });
    return;
  }

  const fakeUser: Express.User = {
    claims: { sub: authProviderId, email },
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  req.login(fakeUser, (err) => {
    if (err) {
      res.status(500).json({ error: "login_failed" });
      return;
    }
    res.json({ ok: true });
  });
});
