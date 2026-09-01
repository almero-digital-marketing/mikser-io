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
    const has = (...names) => names.some(n => argv.includes(n))
    return {
        workingFolder: value('--working-folder', '-i') ?? '.',
        config: value('--config', '-c') ?? 'mikser.config.js',
        clear: has('--clear'),
        standalone: has('--standalone'),
        // Report-only runs read; they do not write the catalogue or the output
        // tree, and their handlers exit the process themselves. Left local —
        // the guard in setup() still says an instance is there.
        reportOnly: has('--tool', '--tools', '--verify', '--explain'),
    }
}

async function main() {
    const where = locate(process.argv.slice(2))
    if (!where.standalone && !where.reportOnly) {
        const code = await forward({
            workingFolder: path.resolve(where.workingFolder),
            config: path.resolve(where.workingFolder, where.config),
            clear: where.clear,
        })
        // null means nobody was listening — carry on exactly as before.
        if (code !== null) process.exit(code)
    }

    const mikser = await setup()
    await mikser.start()
}
main()
