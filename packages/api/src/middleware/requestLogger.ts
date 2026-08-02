import type { RequestHandler } from "express";

// ACC-05: log method/path/status/duration/userId only. Never log request
// or response bodies, query strings, or headers — those can carry wellness
// data, tokens, or other sensitive content. This is the pattern every
// future package's logging should follow; don't add body/query logging to
// this file or anywhere else without re-reading PRD Section 11 first.
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const userId = req.appUser?.id ?? "-";
    console.log(
      JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        userId,
      })
    );
  });

  next();
};
