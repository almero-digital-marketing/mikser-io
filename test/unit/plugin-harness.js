// Moved to ../../testing/harness.js so it ships in the package and every
// plugin can use ONE harness instead of copying it.
//
// The copies had already drifted: mikser-io-layouts' was missing the
// `ready` flag core's had, so a layouts test touching a ready-gated path
// behaved differently from the same code in core. Same failure mode as
// the hand-copied REFS_SCHEMA in test/unit/refs.test.js.
//
// Kept as a re-export so the existing importers in this folder don't all
// have to change at once.
export * from '../../testing/harness.js'
