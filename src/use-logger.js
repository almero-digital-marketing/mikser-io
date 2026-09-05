// The engine's logger, read fresh on every call.
//
// A leaf on purpose. `useLogger` lived in engine.js, which imports the logger
// to build it, while logger/levels.js and logger/progress.js imported
// useLogger back — a cycle that worked only because both bindings are
// hoisted function declarations. Nothing about that was load-bearing; it was
// where the function happened to be written.
//
// Read fresh rather than captured: setLogLevel and addLogTransport both
// REPLACE runtime.engine.logger with a rebuilt instance, so a caller holding
// `const logger = useLogger()` from an earlier phase keeps the old one. That
// is fine for a closure that has already run and wrong for anything that
// outlives a cycle.
import runtime from './runtime.js'

export function useLogger() {
    return runtime.engine?.logger
}
