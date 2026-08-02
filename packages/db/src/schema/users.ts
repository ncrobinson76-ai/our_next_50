import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// User/Account: identity, auth link, locale, timezone, consent version.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Identity + auth link. authProvider/authProviderId together identify
    // which external auth system (email/password, Google, Replit auth, etc.)
    // vouches for this account and its ID there.
    email: text("email").notNull(),
    authProvider: text("auth_provider").notNull(),
    authProviderId: text("auth_provider_id").notNull(),

    locale: text("locale").notNull().default("en-US"),
    timezone: text("timezone").notNull().default("UTC"),

    // Version string of the consent/ToS document the user accepted, plus
    // when — needed to know which policy version governed their data at
    // any point in time. Nullable: a users row is created on first login,
    // before consent has been captured (see packages/api's consent gate,
    // ACC-03) — both fields are null until the user accepts.
    consentVersion: text("consent_version"),
    consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_auth_provider_idx").on(table.authProvider, table.authProviderId),
  ]
);
