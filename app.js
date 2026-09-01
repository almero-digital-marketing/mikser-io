#!/usr/bin/env node
import path from 'node:path'

import { setup } from './index.js'
import { forward } from './src/instance.js'

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

    // What to ask the instance for. Report-only commands go over the same
    // socket as a build: they read, so running them locally never damaged
    // anything, but a catalogue being written by another process is not a
    // catalogue anyone can answer from — a --verify against a half-finished
    // cycle reports drift that is not there.
    const tool = value('--tool')
    const explain = value('--explain')
    const request = has('--tools') ? { type: 'report', tools: true, json: has('--json') }
        : tool                    ? { type: 'report', tool, toolArgs: value('--tool-args'), json: has('--json') }
        : explain                 ? { type: 'report', explain, json: has('--json') }
        : has('--verify')         ? { type: 'report', verify: true, json: has('--json') }
        : { type: 'build', clear: has('--clear') }

    return {
        workingFolder: value('--working-folder', '-i') ?? '.',
        config: value('--config', '-c') ?? 'mikser.config.js',
        // Commander's negated form: `attach` is true unless --no-attach said so.
        attach: has('--no-attach') ? false : true,
        request,
    }
}

async function main() {
    const where = locate(process.argv.slice(2))
    if (where.attach !== false) {
        const code = await forward({
            workingFolder: path.resolve(where.workingFolder),
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
