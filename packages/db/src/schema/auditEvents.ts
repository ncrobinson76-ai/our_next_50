import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

// AuditEvent: enough to reconstruct who-did-what-when for a security review —
// no duplicated sensitive payloads. targetEntityType/targetEntityId are a
// polymorphic reference (they can point at a row in any other table), so
// they're plain columns rather than a foreign key, which Postgres can't
// express across multiple target tables.
//
// Deliberate exception to this schema's usual "cascade on user delete" rule:
// actorUserId/subjectUserId use ON DELETE SET NULL rather than CASCADE, so
// audit history survives account deletion for security-review purposes —
// the row is kept (with a null actor/subject link) instead of being removed.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Which user's data this event pertains to — kept as a direct column
    // (rather than relying on targetEntityType/Id) so queries can always
    // scope by userId, per this schema's rule against ambient cross-user
    // access.
    subjectUserId: uuid("subject_user_id").references(() => users.id, { onDelete: "set null" }),

    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("user"),

    actionType: text("action_type").notNull(),
    targetEntityType: text("target_entity_type").notNull(),
    targetEntityId: uuid("target_entity_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_subject_user_id_idx").on(table.subjectUserId),
    index("audit_events_actor_user_id_idx").on(table.actorUserId),
    index("audit_events_target_idx").on(table.targetEntityType, table.targetEntityId),
  ]
);
