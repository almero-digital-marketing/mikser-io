// One engine per working folder.
//
// Running `mikser` next to a live `mikser --watch` used to start a second
// engine on the same folder: two writers, one sqlite catalogue, one output
// tree, no lock and no warning. WAL keeps the pages intact and does nothing
// for the logical state — a `--clear` from one process while the other holds
// the folder produces a cold rebuild reporting nothing rendered, and output
// that does not match source.
//
// The fix is not a lock alone, because a lock only forbids the thing people
// were doing for a reason. A one-shot build is not faster than the watcher —
// the watcher has usually already done the work — it is started because
// PROCESS EXIT IS THE ONLY COMPLETION SIGNAL. Everything else in mikser
// hot-reloads; nothing else says "the tree is settled, assert against it now".
//
// So a second invocation forwards its request to the running instance and
// wears its result: the instance's log output, the instance's exit code. The
// caller asked for a build and gets an answer about that build, with nothing
// new to learn and no watermark to reason about — which matters, because a
// design that needs discipline from the caller is the one that gets violated.
//
// There is no opt-out. A flag for "run a second engine here anyway" only ever
// enabled the accident this file exists to prevent — two engines sharing one
// catalogue and one output tree with no lock between them — and no caller had
// a reason to want it that a stopped instance would not serve better. An
// option whose only use is the wrong one is not an escape hatch, it is a trap
// with a name.

import net from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { chmod } from 'node:fs/promises'

import runtime from './runtime.js'
import { onLoaded } from './lifecycle.js'
import { renderErrorCount } from './report.js'
import { runReportOnly } from './engine.js'
import { emitReport } from './report.js'

// Where the endpoint lives.
//
// A unix socket rather than a port: no allocation, no auth decision, no
// network exposure. The obvious home is under the working folder, and it does
// not work — sun_path caps a socket path at about 107 bytes, and a working
// folder nested a few levels deep blows through that. It fails as
// `listen EINVAL`, which is not a phrase that suggests "your path is long",
// so it would have been diagnosed as forwarding simply not working.
//
// So: a short, fixed-length name in the system temp directory, derived from
// the resolved working folder. One rule, no length to exceed, and it survives
// an `rm -rf runtime`.
//
// The permissions argument survives the move. The socket is chmod 0600 after
// listen, so it is the owner's alone — /tmp being world-writable buys an
// attacker the ability to create their own socket, not to talk to this one.
//
// Windows has no unix sockets; Node maps this name shape onto a named pipe,
// which has no such length limit.
export function socketPath(workingFolder) {
    const key = createHash('sha1').update(path.resolve(workingFolder ?? '.')).digest('hex').slice(0, 16)
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\mikser-${key}`
        : path.join(tmpdir(), `mikser-${key}.sock`)
}

// ── protocol ────────────────────────────────────────────────────────────
//
// Newline-delimited JSON, one object per line. Deliberately boring: both ends
// ship together, so there is nothing to negotiate and no version to carry.
//
//   → { type: 'build',  config, clear, renderPresets }
//   → { type: 'report', config, tool, tools, toolArgs, explain, auditOutput, fingerprint, json }
//   ← { type: 'log', chunk }        (zero or more, in order)
//   ← { type: 'done', code }
//   ← { type: 'refused', reason, detail }

function frame(socket, object) {
    try { socket.write(JSON.stringify(object) + '\n') } catch { /* peer gone */ }
}

function readFrames(socket, onFrame) {
    let buffer = ''
    socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            if (!line.trim()) continue
            try { onFrame(JSON.parse(line)) } catch { /* not ours */ }
        }
    })
}

// ── client ──────────────────────────────────────────────────────────────

// Ask the running instance to build, and wear its answer.
//
// Returns the exit code to use, or null when there is nobody to ask — in
// which case the caller proceeds exactly as it always did. Called before
// setup(), so a forwarded command never pays for importing the config or the
// plugin graph, which is most of what a one-shot spends its time on.
export function forward({ workingFolder, config, request }) {
    const endpoint = socketPath(workingFolder)

    return new Promise((resolve) => {
        const socket = net.connect(endpoint)
        let answered = false

        // Nobody home. A crash leaves the socket file behind, so "connect
        // failed" has to mean "no instance — clean up and carry on" rather
        // than a hang: this is the way the pattern usually breaks.
        socket.on('error', () => {
            if (answered) return
            answered = true
            if (process.platform !== 'win32' && existsSync(endpoint)) {
                try { unlinkSync(endpoint) } catch { /* another client won the race */ }
            }
            resolve(null)
        })

        socket.on('connect', () => frame(socket, { ...request, config }))

        readFrames(socket, (message) => {
            if (message.type === 'log') {
                // The instance's output for THIS request, on the stream it
                // would have used locally — which requires knowing which
                // stream that was. An instance too old to say defaults to
                // stderr, which is what every frame used to mean.
                const out = message.stream === 'stdout' ? process.stdout : process.stderr
                out.write(message.chunk)
            } else if (message.type === 'refused') {
                answered = true
                process.stderr.write(`mikser: ${message.reason}\n`)
                if (message.detail) process.stderr.write(`${message.detail}\n`)
                socket.end()
                resolve(1)
            } else if (message.type === 'done') {
                answered = true
                socket.end()
                resolve(message.code ?? 0)
            }
        })

        // The instance went away mid-request. Not "success with no output":
        // the build this was asked about has no known outcome.
        socket.on('close', () => {
            if (answered) return
            answered = true
            process.stderr.write('mikser: the running instance closed the connection before finishing.\n')
            resolve(1)
        })
    })
}

// Is somebody already holding this folder?
//
// Used by the commands that cannot be forwarded because they are not requests
// at all — `--server` and `--watch` ask to BECOME the instance. Forwarding one
// builds and exits, and the port never opens: the caller asked for a server on
// 3010, got "completed", and has nothing listening.
//
// Same stale-socket rule as forward(): connect-and-fail means nobody is there,
// never a wait.
export function isInstanceLive(workingFolder) {
    const endpoint = socketPath(workingFolder)
    return new Promise((resolve) => {
        const probe = net.connect(endpoint)
        let settled = false
        const answer = (live) => {
            if (settled) return
            settled = true
            try { probe.destroy() } catch { /* already gone */ }
            if (!live && process.platform !== 'win32' && existsSync(endpoint)) {
                try { unlinkSync(endpoint) } catch { /* another client won the race */ }
            }
            resolve(live)
        }
        probe.on('connect', () => answer(true))
        probe.on('error', () => answer(false))
        setTimeout(() => answer(false), 1000).unref?.()
    })
}

// ── server ──────────────────────────────────────────────────────────────

// Requests run one at a time, to completion.
//
// Not because the engine could not interleave them, but because "which cycle
// covers my edit" is the question this whole thing exists to remove. Serialised,
// a client's answer is about a cycle that started after its request arrived,
// and the log output during that window belongs to exactly one request.
let chain = Promise.resolve()
let server = null

// Tee the process's own output to the client for the duration of its request.
//
// The engine logs through pino to stdout/stderr; capturing there rather than
// adding a log transport means the client sees precisely what it would have
// seen locally, formatting and all, with no second rendering of the same
// records to keep in step.
// WHICH stream, not merely that something was written.
//
// stdout and stderr are not two ways of saying the same thing: under --json,
// --tool and --tools, stdout carries a machine-readable document and stderr
// carries the log, and the split is the entire value of those flags. Capturing
// both into one undifferentiated stream throws that away, and the client can
// only guess — it guessed stderr, so every forwarded document landed where no
// consumer looks while the command exited 0.
function captureOutput(onChunk) {
    const originals = [process.stdout.write, process.stderr.write]
    const patch = (stream, original, name) => function (chunk, encoding, callback) {
        try { onChunk(typeof chunk === 'string' ? chunk : chunk.toString(), name) } catch { /* client gone */ }
        return original.call(stream, chunk, encoding, callback)
    }
    process.stdout.write = patch(process.stdout, originals[0], 'stdout')
    process.stderr.write = patch(process.stderr, originals[1], 'stderr')
    return () => {
        process.stdout.write = originals[0]
        process.stderr.write = originals[1]
    }
}

// Is the config the client resolved the one this instance is running?
//
// The accident this prevents is the one already written down: a command
// resolving mikser.config.prod.js reaching an instance running the dev config
// executes against the wrong one, silently. Compared by resolved PATH rather
// than by content hash — the hash would require the client to import its
// config, which is most of the startup forwarding exists to skip, and it is
// not what tells the two apart. Different configs are different files.
function configMismatch(theirs) {
    if (!theirs) return null
    const mine = path.resolve(runtime.options.config ?? 'mikser.config.js')
    return path.resolve(theirs) === mine ? null : mine
}

// Has this instance's own config changed under it since it started?
//
// The other half of the same question, and the half a client cannot answer.
// configCoverage lists every local module the config graph pulled in, so a
// stat over that list catches an edit to an imported module — which a
// client-side checksum of the entry file would miss entirely.
async function configStale() {
    const covered = runtime.options.configCoverage?.files ?? []
    if (!covered.length) return null
    const { stat } = await import('node:fs/promises')
    const stamps = runtime.options.configStamps
    if (!stamps) {
        // First call: record, do not judge. Nothing to compare against yet.
        runtime.options.configStamps = Object.fromEntries(
            await Promise.all(covered.map(async (file) => {
                try { return [file, (await stat(file)).mtimeMs] } catch { return [file, 0] }
            })))
        return null
    }
    for (const file of covered) {
        let now = 0
        try { now = (await stat(file)).mtimeMs } catch { /* deleted counts as changed */ }
        if (stamps[file] !== now) return file
    }
    return null
}

// Report-only commands, answered from the live catalogue.
//
// These read; they do not write, so running them locally was safe for the
// FILES. It was not safe for the ANSWER. A local --audit-output at ten thousand
// pages reads a catalogue the instance is in the middle of writing and reports
// drift that is a half-finished cycle, and a local --tool answers from
// whatever the last build left rather than from what is true now.
//
// The instance has the settled state and the config that produced it, so it is
// the only process that can answer correctly. Same guards as a build: wrong
// config refuses, drifted config refuses.
async function serveReport(socket, request, logger) {
    const restore = captureOutput((chunk, stream) => frame(socket, { type: 'log', chunk, stream }))
    let code = 0
    try {
        code = await withRequestOutput(request, () => runReportOnly(request)) ?? 0
    } catch (err) {
        logger?.error('instance: forwarded report failed — %s', err.message)
        code = 3
    } finally {
        restore()
    }
    frame(socket, { type: 'done', code })
}

function refuseConfig(socket, request, wrongConfig) {
    frame(socket, {
        type: 'refused',
        reason: `this instance is running ${wrongConfig}, and you asked for ${path.resolve(request.config)}.`,
        detail: 'Answering would use the wrong config — the accident this refusal exists to prevent. '
            + 'Stop that instance and run this again.',
    })
}

// An option the instance's own commander does not recognise.
//
// A forwarded invocation never reaches commander: app.js pre-parses the few
// flags it needs and forwards the rest, so `mikser --bogus` against a running
// watcher built normally and exited 0, while the same command with nothing
// listening was rejected outright. Same words, two answers, and the quiet one
// is the one that looks like it worked.
//
// parseOptions REPORTS unknowns without applying anything, which is what makes
// this safe to run against the live instance's option table.
function refuseUnknownFlags(socket, request) {
    const argv = Array.isArray(request.argv) ? request.argv : null
    if (!argv?.length) return false
    const commander = runtime.engine?.commander
    if (!commander) return false
    let unknown = []
    try {
        unknown = commander.parseOptions([...argv]).unknown ?? []
    } catch {
        return false   // never let a probe refuse a legitimate build
    }
    unknown = unknown.filter(a => a.startsWith('-'))
    if (!unknown.length) return false
    frame(socket, {
        type: 'refused',
        reason: `unknown option ${unknown.map(u => `'${u}'`).join(', ')}.`,
        detail: 'Forwarded to the instance running in this folder, which does not recognise it. '
            + 'The same command with nothing listening would have been rejected too — this says so '
            + 'rather than building as though the flag had been understood.',
    })
    return true
}

// `--clear` against a running instance.
//
// Clearing is a BOOT operation. It removes the output folder, and it closes,
// unlinks and reopens the cache database — which is why the wipe lives at the
// point the database is opened and nowhere else. An instance has that handle
// open with prepared statements held against it all over the engine, its
// manifest and plugin state loaded from what is about to be deleted, and a
// server answering requests out of the folder being removed. There is no
// moment mid-run where this can be done and still mean what the flag means.
//
// It travelled on the request and was never read, so `mikser --clear` against
// a watcher rebuilt normally and exited 0 having cleared nothing: the flag
// looked honoured. Refusing says the only thing that helps, which is that the
// instance has to stop first.
//
// A half-clear would be worse than either: it would report success for an
// operation the caller can no longer describe.
function refuseClear(socket, request) {
    if (!request.clear) return false
    frame(socket, {
        type: 'refused',
        reason: 'a mikser instance is running in this folder, and --clear cannot run while it does.',
        detail: 'Clearing removes the output folder and reopens the cache database, both of which happen '
            + 'once at startup — the running instance holds that database open and serves out of that '
            + 'folder. Stop it and run this again.',
    })
    return true
}

// Which process to restart.
//
// "Restart it" is only actionable if you know which `it` — and the machine
// that hits this is the machine running several instances from several
// projects, because that is what makes a stale config likely in the first
// place. Without the pid, finding it meant walking /proc by cwd.
//
// The instance answers with its OWN pid, which is the one fact a client cannot
// work out: it knows the folder it asked about, not who is holding it. The
// wrong-config refusal beside this one already names both sides; this one
// named neither.
function refuseStale(socket, movedFile) {
    frame(socket, {
        type: 'refused',
        reason: `this instance's config changed on disk since it started (${movedFile}).`,
        detail: `It is still running the old one — pid ${process.pid}, started in `
            + `${runtime.options.workingFolder}. Restart that process and this command will reach an `
            + 'instance that matches what you edited.',
    })
}

// The client's output contract, applied to the instance for one request.
//
// `--json` is answered by two pieces of code that both read runtime.options:
// the logger picks its stream per line, and emitReport() writes nothing at all
// unless the option is set. The instance was started without the flag, so a
// forwarded `--json` was answered under the INSTANCE's contract — a build
// emitted no document whatsoever, and a report emitted one into the same
// stream as the log it was supposed to be separated from.
//
// Tighten only, never loosen. A client asking for a document states something
// the instance cannot know; a client not asking states nothing, and silencing
// an instance that was itself started under `--json` would take a document
// away from whatever is reading ITS stdout.
//
// Per request and restored after, like renderPresets: one client's flag does
// not put the instance into json mode for everyone.
async function withRequestOutput(request, run) {
    const prior = {}
    for (const key of ['json', 'tool', 'tools']) {
        prior[key] = runtime.options[key]
        if (request[key]) runtime.options[key] = request[key]
    }
    try {
        return await run()
    } finally {
        Object.assign(runtime.options, prior)
    }
}

async function serveBuild(socket, request, logger) {
    const restore = captureOutput((chunk, stream) => frame(socket, { type: 'log', chunk, stream }))
    let code = 0
    try {
        // Fire the pending debounce rather than waiting it out.
        //
        // The 1000ms window exists to INFER that editing has stopped. A client
        // asking for a build has STATED it, so inference is not needed and the
        // timer is pure latency. The accumulated events are not discarded by
        // this: the watcher already wrote them into the journal, so clearing
        // the timer and building now covers exactly what it would have.
        clearTimeout(runtime.engine?.processTimeout)

        // RESCAN, not drain.
        //
        // A watch cycle processes what the watcher reported. A client that
        // writes a file and immediately asks for a build can beat the inotify
        // event, so draining what is already queued would build without the
        // change that prompted the request — the watermark bug wearing a
        // different hat. Rescanning makes a forwarded build mean what a
        // one-shot means, which is what every existing caller assumes.
        // Applied for THIS cycle only. A flag the forwarded path drops is a
        // silent no-op, which is the failure this surface exists to remove —
        // and restoring it after keeps the watcher from forcing every later
        // rebuild.
        const priorRenderPresets = runtime.options.renderPresets
        if (request.renderPresets !== undefined) runtime.options.renderPresets = request.renderPresets
        try {
            // The report is emitted by the cycle itself, from inside
            // rebuild() — the same call a one-shot makes. Nothing here
            // re-implements it: the contract is what decides whether it
            // writes, so setting the contract is the whole fix.
            await withRequestOutput(request, async () => {
                // Suppressed for the duration of the cycle and emitted once
                // after it: any cycle already in flight when this request
                // arrived would otherwise write a second document into a
                // stream that promises one.
                runtime.state ??= {}
                runtime.state.suppressReport = true
                try {
                    await runtime.rebuild()
                } finally {
                    runtime.state.suppressReport = false
                }
                emitReport()
            })
        } finally {
            runtime.options.renderPresets = priorRenderPresets
        }

        // From the render-error count, NOT from process.exitCode.
        //
        // The engine deliberately leaves exitCode alone in watch mode — a
        // failed render there is a state to fix on the next cycle, not a
        // reason to tear the watcher down — and the instance is always in
        // watch or server mode. So the signal a one-shot would have exited
        // with does not exist here and has to be read from the report, which
        // is where it came from in the first place.
        code = renderErrorCount() ? 1 : 0
    } catch (err) {
        logger?.error('instance: forwarded build failed — %s', err.message)
        code = 1
    } finally {
        restore()
    }
    frame(socket, { type: 'done', code })
}

// Listen, if this process is one that sticks around.
//
// A one-shot build has nothing to offer a client — it is already exiting — so
// only a watcher or a server publishes an endpoint.
export function serveInstance() {
    onLoaded(async () => {
        if (!runtime.options.watch && !runtime.options.server) return
        const logger = runtime.engine?.logger
        const endpoint = socketPath(runtime.options.workingFolder)

        // A socket left by a crash. Nothing is listening, so removing it is
        // safe — and a live one would have refused this process's own startup
        // long before here, in the client check.
        if (process.platform !== 'win32' && existsSync(endpoint)) {
            try { unlinkSync(endpoint) } catch { /* nothing to remove */ }
        }
        await configStale()   // record the baseline stamps

        server = net.createServer((socket) => {
            socket.on('error', () => { /* client vanished mid-request */ })
            readFrames(socket, (request) => {
                if (request.type !== 'build' && request.type !== 'report') return
                chain = chain.then(async () => {
                    // Both kinds answer for the client's config, not the
                    // instance's — a report against the wrong config is the
                    // original incident, and it is wrong whether or not it
                    // writes anything.
                    if (refuseUnknownFlags(socket, request)) return
                    if (refuseClear(socket, request)) return
                    const wrongConfig = configMismatch(request.config)
                    if (wrongConfig) return refuseConfig(socket, request, wrongConfig)
                    const movedFile = await configStale()
                    if (movedFile) return refuseStale(socket, movedFile)
                    return request.type === 'build'
                        ? serveBuild(socket, request, logger)
                        : serveReport(socket, request, logger)
                }).catch(() => {})
            })
        })
        server.on('error', (err) => {
            logger?.warn({ code: 'instance-listen-failed' },
                'Could not open the control socket (%s). Other mikser commands in this folder will start their '
                + 'own engine instead of talking to this one.', err.message)
        })
        server.listen(endpoint, async () => {
            // The owner's, and nobody else's — the filesystem permission IS
            // the access decision, which is why this needs no token.
            if (process.platform !== 'win32') {
                try { await chmod(endpoint, 0o600) } catch { /* best effort */ }
            }
            logger?.info('Instance socket: %s', endpoint)
        })
        server.unref?.()

        const close = () => {
            try { server?.close() } catch { /* already closed */ }
            if (process.platform !== 'win32' && existsSync(endpoint)) {
                try { unlinkSync(endpoint) } catch { /* gone */ }
            }
        }
        process.on('exit', close)
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.on(signal, () => { close(); process.exit(0) })
        }
    })
}

// Say so when a private engine is starting in a folder someone else holds.
//
// Registered at setup so both halves are wired from one call.
export function instanceControl() {
    serveInstance()
}
