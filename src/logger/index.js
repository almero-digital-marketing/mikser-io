// Logging and progress.
//
// pino is the source of truth for records: everything any plugin or engine
// module emits goes through it, and fans out via `pino.multistream` to the
// pretty terminal stream, to the build report's warnings/faults views, and to
// zero or more third-party transports. Progress runs ALONGSIDE pino — the
// gauge owns the bottom row of the terminal — and the two coordinate so a log
// line never garbles the bar.
//
// One file until 10.12.0, and it had grown three jobs that only shared a
// name:
//
//   streams.js   building the logger, the terminal format, and where a
//                record goes — the mechanism
//   levels.js    which level is in force and who may change it: configured,
//                installed on a running instance, or set for one request —
//                the policy
//   progress.js  the bar, the records that stand in for it where no bar
//                belongs, and the pauseBar/resumeBar the log stream calls
//
// The dependencies run one way: levels → streams → progress. Progress owns
// the gauge and the other two ask it to step aside, rather than any of them
// reaching for it directly.
//
// This file is the surface. Everything the engine imports from
// `./logger/index.js` is re-exported here, so the split is not something a
// caller has to know about.

export { createMikserLogger, addLogTransport } from './streams.js'
export {
    LOG_LEVELS, INSTALLED_LOG_TTL_MS,
    setLogLevel, rememberBaseLevel, installLogLevel, resetLogLevel,
    applyInstalledLogLevel, restingLogLevel, currentLogLevel, installedLogLevel,
    applyLogRequest,
} from './levels.js'
export {
    PROGRESS_INTERVAL_MS, formatDuration,
    trackProgress, updateProgress, stopProgress, updateProgressDetails,
} from './progress.js'
