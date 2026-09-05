// Every code the engine emits has an entry in the codes reference.
//
// A code is a contract, not a log detail: `--json` keys `warnings` and
// `faults` by it, `mikser_ping` surfaces faults by it, and the documented
// advice is to assert on codes rather than on message text, because message
// text is meant to be improved. A code with no entry is a contract nobody
// can look up.
//
// This is a test rather than a note in a checklist because the drift is
// silent and one-directional: adding a code is a one-line change in the
// middle of doing something else, and nothing about the build notices that
// the table did not grow with it. When this file found the gap there were
// seventeen.
//
// Derived from the source, never from a list kept here — a hand-kept list of
// codes goes stale the same way the table does.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = new URL('../../', import.meta.url).pathname

async function walk(dir) {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...await walk(full))
        else if (entry.name.endsWith('.js')) out.push(full)
    }
    return out
}

describe('the codes reference', () => {
    it('has an entry for every code the engine emits', async () => {
        const files = await walk(path.join(root, 'src'))
        const emitted = new Map()
        for (const file of files) {
            const text = await readFile(file, 'utf8')
            for (const m of text.matchAll(/code:\s*'([a-z][a-z0-9-]+)'/g)) {
                if (!emitted.has(m[1])) emitted.set(m[1], path.relative(root, file))
            }
        }
        assert.ok(emitted.size > 20, `expected to find the codes, got ${emitted.size}`)

        const reference = await readFile(path.join(root, 'docs/diagnostics.md'), 'utf8')
        const missing = [...emitted]
            .filter(([code]) => !new RegExp(`\`${code}\``).test(reference))
            .map(([code, file]) => `${code} (${file})`)

        assert.deepEqual(missing, [],
            'these codes are emitted but have no entry in docs/diagnostics.md — '
            + 'a code is what --json keys warnings and faults by, so an undocumented '
            + 'one is a contract nobody can look up')
    })

    it('documents nothing the engine does not emit', async () => {
        // The other direction: a code removed from the source leaves an entry
        // promising a warning that can no longer appear.
        const reference = await readFile(path.join(root, 'docs/diagnostics.md'), 'utf8')
        const table = [...reference.matchAll(/^\| `([a-z][a-z0-9-]+)`(?:, `([a-z][a-z0-9-]+)`)? \| (?:warn|error|info) \|/gm)]
            .flatMap(m => [m[1], m[2]]).filter(Boolean)
        assert.ok(table.length > 20, `expected a populated table, got ${table.length}`)

        const files = await walk(path.join(root, 'src'))
        const emitted = new Set()
        for (const file of files) {
            const text = await readFile(file, 'utf8')
            for (const m of text.matchAll(/code:\s*'([a-z][a-z0-9-]+)'/g)) emitted.add(m[1])
        }
        // Codes owned by sibling packages are documented here too and are not
        // in this repo's source; they carry their package in the heading above
        // them, so they are allowed.
        const siblings = new Set(['preset-unfinished', 'preset-no-match', 'preset-unknown'])
        const phantom = table.filter(c => !emitted.has(c) && !siblings.has(c))
        assert.deepEqual(phantom, [],
            'documented but never emitted — the entry promises a warning that cannot appear')
    })
})
