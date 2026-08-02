import type { Express, RequestHandler } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import passport from "passport";
import memoize from "memoizee";
import type * as OidcClient from "openid-client" with { "resolution-mode": "import" };

// Replit Auth is OpenID Connect. This mirrors the standard integration
// shape (openid-client v6 + passport + express-session, one strategy per
// allowed domain) — see packages/api/README.md for where each piece maps
// to a PRD requirement.
//
// openid-client v6 ships as a pure ESM package. The rest of this monorepo
// is CommonJS (ts-node, no build step), so it's loaded via dynamic
// import() at the couple of call sites that need the runtime module —
// standard Node CJS/ESM interop, not a workaround. Only types are
// statically imported above (erased at compile time, so they don't
// produce a require() call).
//
// Deliberately NOT this file's job: resolving an OIDC identity to a row in
// our own `users` table. That happens in resolveAppUser.ts, on every
// authenticated request, based only on req.user.claims (never on anything
// the client could supply directly) — the same code path runs whether the
// session was established via the real OIDC flow below or via the
// test-only fake-login route used by the isolation test suite. This file's
// job ends at "there is a genuine, server-verified session with claims."

type OidcConfig = OidcClient.Configuration;
type TokenResponse = OidcClient.TokenEndpointResponse & OidcClient.TokenEndpointResponseHelpers;

const getOidcConfig = memoize(
  async (): Promise<OidcConfig> => {
    const client: typeof OidcClient = await import("openid-client");
    return client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000, promise: true }
);

export function getSession(): RequestHandler {
  const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
  const PgStore = connectPg(session);
  const sessionStore = new PgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtlMs,
    tableName: "sessions",
  });

  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // Real Replit deployments are always HTTPS; relaxed outside
      // production so local dev/test over plain HTTP still works.
      secure: process.env.NODE_ENV === "production",
      maxAge: sessionTtlMs,
    },
  });
}

interface SessionUser {
  claims?: { sub: string; email?: string; exp?: number; [key: string]: unknown };
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

function updateUserSession(user: SessionUser, tokens: TokenResponse): void {
  const claims = tokens.claims() as SessionUser["claims"];
  user.claims = claims;
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = claims?.exp;
}

export async function setupAuth(app: Express): Promise<void> {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // The session already contains everything we need (claims + tokens) —
  // no DB round-trip at serialize/deserialize time.
  passport.serializeUser((user, cb) => cb(null, user as Express.User));
  passport.deserializeUser((user, cb) => cb(null, user as Express.User));

  if (process.env.NODE_ENV === "test") {
    // Real OIDC discovery/strategy registration is skipped in tests. The
    // isolation suite authenticates via the test-only
    // /api/_test/login-as route (routes/testAuth.ts), which calls
    // req.login() directly and exercises the exact same
    // session/deserialize path production uses downstream of login.
    return;
  }

  let config: OidcConfig;
  try {
    config = await getOidcConfig();
  } catch (err) {
    // REPL_ID isn't set outside a Repl, and OIDC discovery needs network
    // access — neither should prevent the rest of the server (including
    // the health check) from starting. /api/login and /api/callback just
    // won't be registered.
    console.warn(
      "Replit Auth OIDC discovery failed — /api/login and /api/callback will not be available:",
      err instanceof Error ? err.message : err
    );
    return;
  }

  const { Strategy } = await import("openid-client/passport");

  const verify = async (
    tokens: TokenResponse,
    verified: (err: unknown, user?: Express.User | false) => void
  ) => {
    const user: SessionUser = {};
    updateUserSession(user, tokens);
    verified(null, user as Express.User);
  };

  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  if (domains.length === 0) {
    console.warn(
      "REPLIT_DOMAINS is not set — /api/login and /api/callback will not work until it is."
    );
  }

  for (const domain of domains) {
    const strategy = new Strategy(
      {
        name: `replitauth:${domain}`,
        config,
        scope: "openid email profile offline_access",
        callbackURL: `https://${domain}/api/callback`,
      },
      verify
    );
    passport.use(strategy);
  }

  app.get("/api/login", (req, res, next) => {
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/callback", (req, res, next) => {
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    })(req, res, next);
  });

  app.get("/api/logout", async (req, res) => {
    const client: typeof OidcClient = await import("openid-client");
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID!,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });
}

// ACC-01/ACC-02 both depend on "is this request genuinely authenticated"
// being settled once, centrally, before anything else runs.
export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = req.user as SessionUser | undefined;

  if (!req.isAuthenticated() || !user?.expires_at) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds <= user.expires_at) {
    next();
    return;
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const client: typeof OidcClient = await import("openid-client");
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    next();
  } catch {
    res.status(401).json({ error: "unauthenticated" });
  }
};
