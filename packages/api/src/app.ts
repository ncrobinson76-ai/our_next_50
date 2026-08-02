import express, { Express, NextFunction, Request, Response } from "express";
import "./types";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { resolveAppUser } from "./middleware/resolveAppUser";
import { requireConsent } from "./middleware/requireConsent";
import { attachScopedData } from "./middleware/attachScopedData";
import { requestLogger } from "./middleware/requestLogger";
import { healthRouter } from "./routes/health";
import { consentRouter } from "./routes/consent";
import { participantProfilesRouter } from "./routes/participantProfiles";
import { inboxRouter } from "./routes/inbox";
import { observationsRouter } from "./routes/observations";
import { voiceRouter } from "./routes/voice";
import { timelineRouter } from "./routes/timeline";
import { programWeeksRouter } from "./routes/programWeeks";
import { weeklyReviewsRouter } from "./routes/weeklyReviews";
import { experimentsRouter } from "./routes/experiments";
import { testAuthRouter } from "./routes/testAuth";

// Middleware order encodes the whole ACC-01/02/03 story — read top to
// bottom, each stage narrows what the next stage can assume:
//
//   public                -> healthRouter
//   + verified session    -> isAuthenticated
//   + resolved user row   -> resolveAppUser
//   + (may not have       -> consentRouter (GET/POST consent, works
//     consented yet)         regardless of consent status)
//   + current consent     -> requireConsent
//   + scoped data handle  -> attachScopedData
//   -> everything else (participantProfilesRouter, inboxRouter,
//      observationsRouter, voiceRouter, timelineRouter, programWeeksRouter,
//      weeklyReviewsRouter, experimentsRouter, future routers)
export async function createApp(): Promise<Express> {
  const app = express();

  app.use(requestLogger);
  app.use(healthRouter);

  await setupAuth(app);

  if (process.env.NODE_ENV === "test") {
    app.use(testAuthRouter);
  }

  app.use(isAuthenticated);
  app.use(resolveAppUser);
  app.use(consentRouter);
  app.use(requireConsent);
  app.use(attachScopedData);

  app.use(participantProfilesRouter);
  app.use(inboxRouter);
  app.use(observationsRouter);
  app.use(voiceRouter);
  app.use(timelineRouter);
  app.use(programWeeksRouter);
  app.use(weeklyReviewsRouter);
  app.use(experimentsRouter);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error("Unhandled error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
