import type { ScopedDataAccess } from "./data/scopedDataAccess";

export interface AppUser {
  id: string;
  email: string;
  authProvider: string;
  authProviderId: string;
  locale: string;
  timezone: string;
  consentVersion: string | null;
  consentAcceptedAt: Date | null;
  createdAt: Date;
}

declare global {
  namespace Express {
    // Populated by replitAuth.ts's verify callback / test login route —
    // the server-verified session identity. Never trust anything else as
    // "who this request is from."
    interface User {
      claims?: {
        sub: string;
        email?: string;
        [key: string]: unknown;
      };
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    }

    interface Request {
      // Set by resolveAppUser (ACC-01) once req.user.claims has been
      // resolved to a real users row.
      appUser?: AppUser;
      // Set by attachScopedData (ACC-02), after appUser is resolved. Route
      // handlers should only ever touch user-owned tables through this.
      data?: ScopedDataAccess;
    }
  }
}
