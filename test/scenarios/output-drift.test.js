// The same inputs produced different bytes.
//
// This is the check --audit-output structurally cannot make. Audit compares
// each output against the hash its OWN render recorded, and every render
// rewrites that snapshot — so a render whose output changed records the new
// bytes and then matches them. A regression verifies clean by construction,
// which is exactly what was reported: break a render with a watcher running,
// forward the audit to it, and the output on disk is the changed bytes while
// the check says OK.
//
// Detected at commit instead, where the row about to be replaced is still
// readable and carries both hashes. Unchanged inputHash + changed outputHash
// is a rendering change nobody asked for: an upgraded renderer, a changed
// helper, a dependency that shifted under the build.
//
// Here the untracked input is a file the sidecar reads with plain fs, so no
// dependency edge is recorded and the entity's inputHash is blind to it.
// Changing it moves the output without moving any inputHash, which is the
// condition under test. In production the same shape arrives as a package
// upgrade: the renderer changed, no content did.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

// Reads a file WITHOUT recording it as a dependency, so the entity's
// inputHash is blind to it.
const SIDECAR = [
    "import { readFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    "export async function load({ runtime }) {",
    "    // Plain fs: no dependency edge is recorded, so the entity's inputHash",
    "    // is blind to this file. That is the condition under test.",
    "    const p = path.join(runtime.options.workingFolder, 'untracked.txt')",
    "    return { flavour: (await readFile(p, 'utf8')).trim() }",
    "}",
].join('\n')

describe('output drift', () => {
    const workdir = freshWorkdir('output-drift')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.html.hbs': '<!doctype html><body>{{data.flavour}}</body>',
            'layouts/page.js': SIDECAR,
            'untracked.txt': 'ORIGINAL\n',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
    })

    it('says nothing when a rebuild reproduces the same bytes', async () => {
        // The guard against a check that fires on everything: --force
        // re-renders with unchanged inputs, and identical output is the
        // expected result.
        const { combined } = await runMikser(workdir, ['--force'])
        assert.doesNotMatch(combined, /Output changed with unchanged inputs/,
            `a reproducible build must not report drift\n${combined}`)
    })

    it('reports the entity when output moves and no input did', async () => {
        await writeFile(path.join(workdir, 'untracked.txt'), 'CHANGED\n')

        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, `drift is a warning, not a failure\n${combined}`)
        assert.match(combined, /Output changed with unchanged inputs: \/documents\/index\.html/,
            `expected the drifted entity to be named\n${combined}`)
        assert.match(combined, /produced different bytes from the same inputs/,
            `expected the summary to explain the class of cause\n${combined}`)
    })

    it('settles once the new bytes are the recorded ones', async () => {
        // Drift is reported at the moment it happens, not forever after. The
        // snapshot now holds the new output, so a further rebuild is quiet —
        // which is what makes it usable in a watch loop.
        const { combined } = await runMikser(workdir, ['--force'])
        assert.doesNotMatch(combined, /Output changed with unchanged inputs/,
            `it must not keep reporting a change it already recorded\n${combined}`)
    })
})
