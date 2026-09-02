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
        : { type: 'build', clear: has('--clear'), renderPresets: has('--render-presets') ? (value('--render-presets') ?? true) : undefined }

    return {
        longRunning,
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

    if (!where.longRunning) {
        const code = await forward({
            workingFolder,
            config: path.resolve(where.workingFolder, where.config),
            request: where.request,
        })
        // null means nobody was listening — carry on exactly as before.
        if (code !== null) process.exit(code)
    }

    const mikser = await setup()
    await mikser.start()
}
main()
