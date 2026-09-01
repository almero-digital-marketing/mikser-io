// Render helpers like asset() and resource() BUILD a URL from a naming
// convention rather than looking up an entity. Nothing checks that the
// file at the other end was ever produced, so a preset that failed to
// run, or a template naming an extension the preset no longer emits,
// ships a page full of 404s that the build reports as a success.
//
// Every such helper call records its destination on the render track.
// At finalize the engine checks each one against the output folder.
//
// Verifies:
//   1. A helper call whose derivative exists stays silent
//   2. A helper call whose derivative was never produced warns, naming
//      both the missing path and the page that linked it
//   3. The warning counts against the total, so the summary is honest

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, files, assets, frontMatter, renderHbs, assetUrlHelper } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), files(), frontMatter(),
        assets({ presets: { web: { match: ['/files/media/**'] } } }),
        layouts(), renderHbs(), assetUrlHelper(),
    ],
}
`

// A preset module that just copies the source through, so the
// derivative genuinely lands in the assets folder.
const WEB_PRESET = `
import { mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
export const revision = 1
export default async function web({ entity }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    await copyFile(entity.source ?? entity.uri, entity.destination)
}
`

const PAGE = '---\nlayout: page\nhref: /index.html\n---\n'

const LAYOUT_REAL =
    '<!doctype html><body>{{#with (asset "web" "/media/real.jpg")}}<img src="{{url}}">{{/with}}</body>'

// Same page, plus a second asset() call for a source file that does not
// exist — so no derivative is ever rendered for it.
const LAYOUT_WITH_GHOST =
    '<!doctype html><body>{{#with (asset "web" "/media/real.jpg")}}<img src="{{url}}">{{/with}}' +
    '{{#with (asset "web" "/media/ghost.jpg")}}<img src="{{url}}">{{/with}}</body>'

describe('render asset usage checked against the output', () => {
    const workdir = freshWorkdir('asset-use')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': WEB_PRESET,
            'documents/index.html': PAGE,
            'layouts/page.html.hbs': LAYOUT_REAL,
            'files/media/real.jpg': 'not really a jpeg, the preset only copies it',
        })
    })

    it('stays silent when the linked derivative is in the output', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /not in the output/,
            `a derivative that was actually rendered must not be reported missing\n${combined}`)
    })

    it('warns naming the missing file and the page that linked it', async () => {
        await writeFile(path.join(workdir, 'layouts/page.html.hbs'), LAYOUT_WITH_GHOST)

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(combined, /Linked but not in the output: \/assets\/web\/media\/ghost\.jpg/,
            `expected the missing derivative to be named\n${combined}`)
        assert.match(combined, /referenced by \/documents\/index\.html/,
            `expected the linking page to be named, so the author knows where to look\n${combined}`)
    })

    it('counts only the missing ones, leaving the rendered derivative out', async () => {
        const { combined } = await runMikser(workdir, ['--force'])
        assert.match(combined, /1 of 2 linked file\(s\) are not in the output/,
            `both helper calls should be counted, only one reported missing\n${combined}`)
    })
})
