// What log level is in force, and who is allowed to change it.
//
// Three levels, and they are not the same question:
//   baseLevel      what the run was configured with, so a reset has something
//                  to return to
//   installedLevel set on a RUNNING instance with --log-install; outlives a
//                  request, expires on its own, and is disclosed every cycle
//   the request    a per-request --log, restored by the instance contract
//
// The mechanism that actually swaps the streams is streams.js. This module
// decides only what should be in force.

import runtime from '../runtime.js'
import { useLogger } from '../engine.js'
import { onFinalized } from '../lifecycle.js'
import { applyStreamLevel, streamLevel } from './streams.js'

// The levels a person can ask for, in pino's order.
export const LOG_LEVELS = ['trace', 'debug', 'info', 'notice', 'warn', 'error', 'fatal', 'silent']

// What the run was configured with, so a reset has something to return to.
let baseLevel = 'info'
// { level, expiresAt } — set by --log-install, survives the request that set it.
let installedLevel = null

// Move the level, and mean it.
//
// `--debug` used to set runtime.engine.logger.level and stop there, which did
// nothing observable: the pino INSTANCE accepted debug records while the
// terminal stream still filtered them at the level it was constructed with,
// so they were accepted and discarded. It only ever worked when a logging
// transport happened to be configured, because that is the one path that
// rebuilt the logger. Measured on 10.4.0: identical output with and without
// the flag, down to the line count.
//
// So the stream entry moves too, and the instance is rebuilt over the live
// stream list the way addLogTransport already does — same swap, so a transport
// added earlier survives.
//
// TRANSPORTS KEEP THEIR OWN LEVEL. They were built with the level they
// declared, and `--log debug` is a statement about what the operator wants to
// SEE, not an instruction to flood Better Stack. A transport that wants more
// says so in its own entry.
export function setLogLevel(level) {
    if (!LOG_LEVELS.includes(level)) return false
    return applyStreamLevel(level)
}

export function rememberBaseLevel(level) {
    if (LOG_LEVELS.includes(level)) baseLevel = level
}

// Raise the level on a RUNNING instance, until it expires.
//
// The case a per-request flag structurally cannot serve: a watcher's own
// rebuilds. Today the only way to make a misbehaving production instance
// verbose is to restart it — which drops every connected MCP and drive
// session, and is the incident path, so the tool you need is available only by
// performing the risky act you are trying to diagnose.
//
// EXPIRES, because the failure mode is a full disk weeks later with nobody
// remembering who asked. It also dies with the process, so a restart is a
// second guarantee rather than the only one.
export function installLogLevel(level, ttlMs = INSTALLED_LOG_TTL_MS) {
    if (!LOG_LEVELS.includes(level)) return false
    installedLevel = { level, expiresAt: Date.now() + ttlMs }
    return setLogLevel(level)
}

export function resetLogLevel() {
    installedLevel = null
    return setLogLevel(baseLevel)
}

// What is in force, and whether an installed level has run out. Called at the
// top of a cycle so expiry lands on a build boundary rather than mid-render.
export function applyInstalledLogLevel() {
    if (!installedLevel) return null
    if (Date.now() >= installedLevel.expiresAt) {
        const expired = installedLevel.level
        installedLevel = null
        setLogLevel(baseLevel)
        return { expired, level: baseLevel }
    }
    if (streamLevel() !== installedLevel.level) setLogLevel(installedLevel.level)
    return { level: installedLevel.level, expiresAt: installedLevel.expiresAt }
}

// Where the level RESTS between requests: an installed one if there is one,
// otherwise what the run was configured with.
//
// The single rule the restore needs. Putting back "the level before this
// request" instead was wrong for exactly one case and it was the important
// one: --log-reset captured debug, cleared it, and the restore put debug back,
// so the reset appeared to do nothing.
export function restingLogLevel() {
    return installedLevel?.level ?? baseLevel
}

// What is in force right now, so a caller can put it back.
export function currentLogLevel() {
    return streamLevel() ?? baseLevel
}

export function installedLogLevel() {
    return installedLevel ? { ...installedLevel } : null
}

// Thirty minutes: long enough to reproduce something on a live instance,
// short enough that forgetting costs a log file rather than a disk.
export const INSTALLED_LOG_TTL_MS = 30 * 60 * 1000



// What a caller asked for about logging, applied the same way from argv and
// from a forwarded request.
//
// It was written twice and the copies drifted immediately: the argv path threw
// on an unknown level and set `info`, the forwarded path called setLogLevel and
// ignored the false it returns. So `--log chatty` exited 1 locally and built
// normally with a watcher up, and `--log silent` left the progress bar running
// on an instance. The same forwarded/local split --json and --force each had,
// and this feature's own argument against itself: a flag that lies is worse
// than a flag that is missing.
//
// Returns an error STRING rather than throwing, because the two callers need
// different things from a failure — argv throws, the instance refuses over the
// socket — and a shared implementation should not decide that for them.
export function applyLogRequest({ log, logInstall, logReset } = {}) {
    for (const [flag, level] of [['--log', log], ['--log-install', logInstall]]) {
        if (level !== undefined && level !== null && !LOG_LEVELS.includes(level)) {
            return `${flag} ${level}: no such level. Levels: ${LOG_LEVELS.join(', ')}`
        }
    }
    if (logReset) resetLogLevel()
    if (logInstall) installLogLevel(logInstall)
    if (log) setLogLevel(log)

    // A bar on top of debug output is noise, and silent means silent.
    const level = log || logInstall
    if (level === 'trace' || level === 'debug' || level === 'silent') {
        runtime.options.info = false
    }
    return null
}

// An installed level, disclosed and expired, once per cycle.
//
// Disclosed for the reason an installed command is: it is state left on a live
// instance that changes what the process does, and the person who finds it
// weeks later is not the person who set it. A level at debug is quieter to
// leave behind than a probe and louder in effect — the deployment's out log is
// already 1.6MB, and a watcher rebuilding on every editor save at debug grows
// it fast. The failure lands as a full disk with nobody remembering who asked.
//
// Expiry is checked here rather than on a timer so it lands on a build
// boundary instead of mid-render, and the level also dies with the process, so
// a restart is a second guarantee rather than the only one.
//
// onFinalized, matching where the commands plugin announces an installed
// command — the report is reset at the top of a cycle, and a warning raised
// anywhere earlier than the last hook did not survive into the document a
// forwarded --json emits. Measured, not assumed: on onImport and on onFinalize
// the line reached the instance's log and the report stayed empty.
onFinalized(() => {
    const state = applyInstalledLogLevel()
    if (!state) return
    const logger = useLogger()
    if (state.expired) {
        logger?.info('Log level installed with --log-install has expired; back to %s', state.level)
        return
    }
    const minutes = Math.max(0, Math.round((state.expiresAt - Date.now()) / 60000))
    logger?.warn(
        { code: 'log-level-installed', level: state.level, expiresIn: `${minutes}m` },
        'This instance is running at log level %s, installed with --log-install — it is not the '
        + 'configured level and it is not this build asking for it. Expires in %dm, or on --log-reset, '
        + 'or when the process restarts.',
        state.level, minutes)
})
