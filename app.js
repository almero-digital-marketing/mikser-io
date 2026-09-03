#!/usr/bin/env node
import path from 'node:path'

import { setup } from './index.js'
import { forward, isInstanceLive } from './src/instance.js'

// Before anything is imported or read.
//
// A second `mikser` in a folder a watcher already holds used to start a second
// engine: two writers, one catalogue, one output tree, no warning. It forwards
// the request instead and wears the answer — which also means it never pays to
// import the config or the plugin graph, most of what a one-shot spends.
//
// Only the flags that decide WHERE are parsed here. Everything else is the
// running instance's business, and parsing it properly is what commander is
// for once we know we are staying.
function locate(argv) {
    const value = (...names) => {
        for (const name of names) {
            const i = argv.indexOf(name)
            if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
            const inline = argv.find(a => a.startsWith(`${name}=`))
            if (inline) return inline.slice(name.length + 1)
        }
        return null
    }
    const has = (...names) => names.some(n => argv.includes(n) || argv.some(a => names.some(x => a.startsWith(`${x}=`))))

    // Asking to BECOME the instance, rather than asking one for something.
    // Not forwardable in principle: a running engine cannot open a listener on
    // someone else's behalf, and forwarding it built, printed "completed" and
    // exited with nothing on the port.
    const longRunning = has('--watch', '-w', '--server', '-s')

    // Answerable without an engine, and therefore never forwarded.
    //
    // `--help` and `--version` do not describe a build: commander answers them
    // from the option table and exits. Forwarding them sent an instance a
    // request it could not recognise — commander does not list help among the
    // options parseOptions reports on — so refuseUnknownFlags rejected
    // `--help` as an unknown flag, with a detail line claiming "the same
    // command with nothing listening would have been rejected too", which is
    // the opposite of true: with nothing listening it prints the help.
    //
    // Which made the help unreachable in exactly the situation that sends
    // someone to it — a watcher running, wondering which check answers which
    // question — and made a correct refusal say something false.
    const answeredLocally = has('--help', '-h', '--version', '-V')

    // What to ask the instance for. Report-only commands go over the same
    // socket as a build: they read, so running them locally never damaged
    // anything, but a catalogue being written by another process is not a
    // catalogue anyone can answer from — a --audit-output against a half-finished
    // cycle reports drift that is not there.
    const tool = value('--tool')
    const explain = value('--explain')
    const request = has('--tools') ? { type: 'report', tools: true, json: has('--json') }
        : tool                    ? { type: 'report', tool, toolArgs: value('--tool-args'), json: has('--json') }
        : explain                 ? { type: 'report', explain, json: has('--json') }
        : has('--audit-output')   ? { type: 'report', auditOutput: true, json: has('--json') }
        : has('--fingerprint')    ? { type: 'report', fingerprint: true, json: has('--json') }
        : { type: 'build',
            clear: has('--clear'),
            // Not a flag that happens to be set — the client's OUTPUT
            // CONTRACT. `--json` promises the document on stdout and every
            // log line on stderr, and BOTH halves are decided by the process
            // that does the writing. Forwarded, that is the instance, which
            // was started without the flag. So the contract has to travel
            // with the request or it is not honoured at all.
            json: has('--json'),
            // Travels for the same reason clear and renderPresets do: it
            // changes what the CYCLE does, and the instance was started
            // without it. A forwarded --force silently did not force — it
            // rebuilt whatever the gates let through, which on a settled tree
            // is nothing, and a caller asking for a full re-render got a no-op
            // reported as success.
            force: has('--force', '-f'),
            renderPresets: has('--render-presets') ? (value('--render-presets') ?? true) : undefined }

    return {
        longRunning,
        answeredLocally,
        // The flags this process was invoked with, forwarded so the INSTANCE
        // can reject an unknown one. This pre-parser reads the few options it
        // needs and passes the rest along, so commander never runs on a
        // forwarded invocation — and a typo was accepted in silence, built,
        // and reported success.
        argv,
        workingFolder: value('--working-folder', '-i') ?? '.',
        config: value('--config', '-c') ?? 'mikser.config.js',
        request,
    }
}

async function main() {
    const where = locate(process.argv.slice(2))
    const workingFolder = path.resolve(where.workingFolder)

    // A second server or watcher is the hazard this whole surface exists to
    // remove, and it is the one shape that cannot be answered by forwarding.
    // So it stops, rather than silently doing something else.
    if (where.longRunning) {
        if (await isInstanceLive(workingFolder)) {
            process.stderr.write(
                'mikser: another mikser is already running in this folder, and a server or watcher cannot be '
                + 'forwarded to it — it would have to open a port on your behalf.\n'
                + 'Stop that one first.\n')
            process.exit(1)
        }
    }

    // `--help` and `--version` never travel. Commander answers them from the
    // option table and exits, so there is nothing to ask an instance for — and
    // asking got them refused as unknown flags, since commander does not list
    // help among the options parseOptions reports on.
    if (!where.longRunning && !where.answeredLocally) {
        const code = await forward({
            workingFolder,
            config: path.resolve(where.workingFolder, where.config),
            request: { ...where.request, argv: where.argv },
        })
        // null means nobody was listening — carry on exactly as before.
        if (code !== null) process.exit(code)
    }

    const mikser = await setup()
    await mikser.start()
}
main()
