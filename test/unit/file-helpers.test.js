// Template filesystem helpers, and the dependency each read creates.
//
// A template that reads a file depends on it. Until these recorded, the
// render's refClosure named none of what it read — so editing the file
// rebuilt nothing, and the build stayed green while the output went stale.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { load } from '../../src/plugins/render/file.js'
import { createTrack } from '../../src/track.js'

let dir, runtime, track, warnings

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-fh-'))
    await mkdir(path.join(dir, 'styles', 'sections'), { recursive: true })
    await mkdir(path.join(dir, 'documents'), { recursive: true })
    await writeFile(path.join(dir, 'styles', 'base.css'), 'body{}')
    await writeFile(path.join(dir, 'styles', 'sections', 'hero.css'), '.hero{}')
    await writeFile(path.join(dir, 'documents', 'conf.json'), '{"a":1}')

    runtime = {}
    track = createTrack()
    warnings = []
    // `options` is what the engine hands a render plugin; the render-time
    // `runtime` is a per-render projection with no options on it.
    load({
        runtime,
        options: {
            workingFolder: dir,
            // As useSource records them — every collection whose files become
            // entities, including ones a project registers with sources().
            sourceFolders: {
                documents: path.join(dir, 'documents'),
                styles: path.join(dir, 'styles'),
            },
        },
        track,
        logger: { warn: (o, ...a) => warnings.push({ ...o, a }) },
    })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('reading one file', () => {
    it('records the file it read', () => {
        runtime.readFile('documents/conf.json')
        // Keyed on `id`, not `uri`: for a `files` entity `uri` is where the
        // file was DEPLOYED, so a uri edge matches nothing for exactly the
        // case these helpers are most used for.
        assert.deepEqual(track.queries, [{ id: '/documents/conf.json' }])
    })

    it('resolves relative to the working folder, not the process cwd', () => {
        // This used to be readFileSync(name), which happened to work when
        // mikser was started from the working folder and broke anywhere else.
        const content = runtime.readFile('documents/conf.json')
        assert.equal(content, '{"a":1}')
        assert.equal(track.queries[0].id, '/documents/conf.json')
    })

    it('parses and records for jsonFile too', () => {
        assert.deepEqual(runtime.jsonFile('documents/conf.json'), { a: 1 })
        assert.equal(track.queries.length, 1)
    })

    it('records nothing when told the read is not a dependency', () => {
        runtime.readFile('documents/conf.json', { track: false })
        assert.deepEqual(track.queries, [])
    })
})

describe('globbing', () => {
    it('actually returns the files', () => {
        // globby.sync does not exist — the export is globbySync — so every
        // call to this helper threw TypeError before.
        const found = runtime.glob('styles/**/*.css')
        assert.equal(found.length, 2, 'both stylesheets')
    })

    it('records the PATTERN, not the paths it matched', () => {
        // Recording matches would rebuild when a matched file changes but not
        // when a NEW one appears, and appearing is half of what a glob is for.
        runtime.glob('styles/**/*.css')
        assert.equal(track.queries.length, 1)
        const filter = track.queries[0]
        assert.ok(filter.id?.$regex, 'a pattern edge, not a list of paths')

        const re = new RegExp(filter.id.$regex)
        assert.ok(re.test('/styles/sections/hero.css'), 'matches what exists')
        assert.ok(re.test('/styles/later.css'), 'and what does not exist yet')
        assert.equal(re.test('/documents/conf.json'), false, 'and nothing else')
    })

    it('takes an array of patterns', () => {
        runtime.glob(['styles/*.css', 'documents/*.json'])
        assert.equal(track.queries.length, 2)
    })

    it('records nothing with track: false', () => {
        runtime.glob('styles/**/*.css', { track: false })
        assert.deepEqual(track.queries, [])
    })
})

describe('the limit, said out loud', () => {
    it('warns when the file is outside every folder entities come from', async () => {
        // mikser can only invalidate on entities. A file nothing watches
        // cannot be brought back by any edge — and "tracked it" and "there was
        // nothing to track" otherwise read identically from a template.
        await writeFile(path.join(dir, 'loose.txt'), 'x')
        runtime.readFile('loose.txt')
        assert.equal(warnings[0]?.code, 'untracked-file-read')
    })

    it('says it once, not once per render', async () => {
        await writeFile(path.join(dir, 'loose.txt'), 'x')
        runtime.readFile('loose.txt')
        runtime.readFile('loose.txt')
        assert.equal(warnings.length, 1)
    })

    it('stays quiet for a file that does have an entity', () => {
        runtime.readFile('documents/conf.json')
        assert.deepEqual(warnings, [])
    })

    it('stays quiet for a collection the project registered itself', () => {
        // The regression: the folder set was hardcoded to five content
        // folders, so every file in a sources()-registered collection was
        // reported as untracked. On a real site that was 63 warnings a build,
        // all of them wrong — which teaches you to filter the channel, and the
        // filtered-out line is the real one.
        runtime.readFile('styles/base.css')
        assert.deepEqual(warnings, [], 'styles is a registered source; its files DO have entities')
    })

    it('says nothing at all when no sources are registered yet', () => {
        // Nothing registered means nothing can be concluded, and silence is
        // the only honest answer. Guessing is what produced the false ones.
        const bare = {}
        const quiet = []
        load({
            runtime: bare,
            options: { workingFolder: dir },
            track: createTrack(),
            logger: { warn: (o) => quiet.push(o) },
        })
        bare.readFile('documents/conf.json')
        assert.deepEqual(quiet, [])
    })
})
