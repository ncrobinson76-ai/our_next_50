// Re-exports packages/db's schema and client via a relative import rather
// than a real npm dependency — the two packages are siblings in this
// monorepo with no build/publish step between them, so this is the
// simplest correct way to share the schema without inventing a workspace
// setup for a two-file dependency. Every other file in this package should
// import from "./db", not reach into packages/db directly, so this stays
// the single place that relative path lives.
export * from "../../db/src/schema";
export { db } from "../../db/src/client";
