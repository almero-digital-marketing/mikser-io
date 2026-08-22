// Re-export of ../../testing/harness.js, which is where the harness lives
// so it ships in the package and every sibling plugin can import ONE copy
// (`mikser-io/testing/harness.js`) instead of keeping its own.
//
// A copy drifts: it stops carrying fields the real one gains, and a test
// touching a path gated on such a field then behaves differently from the
// same code in the engine. Same reason REFS_SCHEMA is exported from
// src/refs.js rather than pasted into its test.
//
// This file stays so the importers in this folder resolve unchanged.
export * from '../../testing/harness.js'
