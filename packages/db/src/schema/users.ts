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
    // any point in time.
    consentVersion: text("consent_version").notNull(),
    consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_auth_provider_idx").on(table.authProvider, table.authProviderId),
  ]
);
