// A watch cycle that fails must not take the watcher with it.
//
// Reported from a real site under `npm start`: `layouts/lib/context.js` was
// edited in two saves, the watcher rebuilt between them, and the half-saved
// module referenced a const it did not define yet. The sidecar's load() threw
// `SHARE_IMAGE_DEFAULT is not defined`, the log said so — and then the process
// printed "💥 Unhandled rejection" and exited. Under pm2 the same half-saved
// edit arriving over WebDAV or git takes the site's builder down.
//
// Three layers let it through, and each is tested on its own here because
// each one alone would have kept the process alive:
//
//   - layouts rethrew the sidecar's error out of onBeforeRender, so one
//     page's data failure aborted the whole cycle for every page;
//   - the watcher's debounce timer awaited runtime.process() with nothing to
//     catch it, so the aborted cycle became an unhandled rejection;
//   - the unhandledRejection floor in app.js, which exists to keep a watcher
//     alive through exactly that, decided "one-shot or long-running" when it
//     was installed — before the CLI was parsed — so it never saw --watch and
//     treated every rejection as fatal.
//
// In real subprocesses, because a watcher dying is the assertion.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setupFixture, cleanup, freshWorkdir, stripAnsi, MIKSER_ROOT } from './_harness.js'

// A watcher with its output collected, and a way to wait on what it says.
//
// Every wait is on a line the engine prints, never on the clock: a fixed
// settle passes locally and fails on a loaded CI box.
function startWatcher(workdir) {
    const watcher = { output: '', exited: null }
    watcher.child = spawn(process.execPath,
        ['--no-warnings', path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir, '--watch'],
        { cwd: MIKSER_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
          env: { ...process.env, NO_COLOR: '1', NODE_PATH: path.dirname(MIKSER_ROOT) } })
    watcher.child.stdout.on('data', (d) => { watcher.output += stripAnsi(d.toString()) })
    watcher.child.stderr.on('data', (d) => { watcher.output += stripAnsi(d.toString()) })
    watcher.child.on('exit', (code, signal) => { watcher.exited = { code, signal } })

    watcher.count = (pattern) => (watcher.output.match(new RegExp(pattern, 'g')) ?? []).length
    watcher.completions = () => watcher.count('Mikser completed')
    // Resolves true once `pattern` has been printed `n` times, false if the
    // process exits first or 30s pass. Exiting is checked on every turn so a
    // dead watcher fails the wait at once with its own output, rather than
    // as a timeout that says nothing about why.
    watcher.waitFor = async (pattern, n = 1) => {
        for (let i = 0; i < 300; i++) {
            if (watcher.count(pattern) >= n) return true
            if (watcher.exited) return false
            await new Promise(r => setTimeout(r, 100))
        }
        return false
    }
    watcher.stop = async () => {
        if (watcher.child?.pid && !watcher.exited) {
            try { process.kill(-watcher.child.pid, 'SIGKILL') } catch {}
        }
        watcher.child?.stdout?.destroy()
        watcher.child?.stderr?.destroy()
    }
    return watcher
}

const alive = (watcher) =>
    assert.equal(watcher.exited, null,
        `the watcher exited (${JSON.stringify(watcher.exited)})\n${watcher.output}`)

describe('a sidecar whose load() throws while --watch is running', () => {
    // The report, reproduced: a helper inside the layouts folder, saved
    // halfway, with the const it uses not written yet.
    const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts({ autoLayouts: true }), renderHbs()] }
`
    const SIDECAR = "import { pageContext } from './lib/context.js'\n"
        + 'export async function load({ entity }) { return pageContext(entity) }\n'
    const GOOD = (label) => `const SHARE_IMAGE_DEFAULT = '${label}'\n`
        + 'export function pageContext() { return { image: SHARE_IMAGE_DEFAULT } }\n'
    // The first of the two saves: the function references the const, the
    // const is not there yet. Parses and imports fine; throws when called.
    const HALF_SAVED = 'export function pageContext() { return { image: SHARE_IMAGE_DEFAULT } }\n'

    const workdir = freshWorkdir('watch-sidecar-throw')
    const context = () => path.join(workdir, 'layouts/lib/context.js')
    const page = (name) => readFile(path.join(workdir, `out/${name}/index.html`), 'utf8')
    let watcher

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<h1>{{data.image}}</h1>',
            'layouts/page.js': SIDECAR,
            'layouts/lib/context.js': GOOD('FIRST'),
            // A second page on a layout with no sidecar. Editing anything
            // under layouts/ moves the digest every layout shares, so the
            // half-saved helper re-dispatches this one in the same cycle —
            // which is what lets the test see whether one failing sidecar
            // still stops every other page.
            'layouts/plain.hbs': '<p>plain</p>',
            'documents/a.md': '---\nlayout: page\n---\n',
            'documents/b.md': '---\nlayout: plain\n---\n',
        })
        watcher = startWatcher(workdir)
        assert.ok(await watcher.waitFor('Mikser completed'), `the watcher never finished its first build\n${watcher.output}`)
        assert.match(await page('a'), /FIRST/)
    })
    after(async () => {
        await watcher?.stop()
        await cleanup(workdir)
    })

    let failingCycle = ''

    it('reports the failure, completes the cycle and stays alive', async () => {
        const before = watcher.completions()
        const mark = watcher.output.length
        await writeFile(context(), HALF_SAVED)
        assert.ok(await watcher.waitFor('Mikser completed', before + 1),
            `the half-saved helper's cycle never completed\n${watcher.output}`)
        const cycle = failingCycle = watcher.output.slice(mark)
        assert.match(cycle, /load\(\) threw/, cycle)
        assert.match(cycle, /\(at layouts\/lib\/context\.js:1:\d+\)/,
            `the line must say which file threw — the message alone names a const, not a module\n${cycle}`)
        assert.match(cycle, /SHARE_IMAGE_DEFAULT is not defined/, cycle)
        assert.match(cycle, /Mikser completed with 1 render error/,
            `a page that could not be built is a render error, the same as a template that throws\n${cycle}`)
        assert.doesNotMatch(watcher.output, /Unhandled rejection/, watcher.output)
        alive(watcher)
    })

    it('still renders the pages that did not fail', async () => {
        // Rethrowing from onBeforeRender aborted the dispatch for every page
        // after the failing one — this page has no sidecar at all.
        assert.match(failingCycle, /Rendered: 1\b/,
            `the page with no sidecar was not rendered in the failing cycle\n${failingCycle}`)
    })

    it('keeps the last good output for the page that failed', async () => {
        assert.match(await page('a'), /FIRST/)
    })

    it('recovers on the next save', async () => {
        const before = watcher.completions()
        const mark = watcher.output.length
        await writeFile(context(), GOOD('SECOND'))
        assert.ok(await watcher.waitFor('Mikser completed', before + 1),
            `the second save started no cycle\n${watcher.output}`)
        assert.match(await page('a'), /SECOND/,
            `the completing save did not re-render the page\n${watcher.output}`)
        const cycle = watcher.output.slice(mark)
        assert.doesNotMatch(cycle, /render error/, cycle)
        // The save that repaired the page is a dependency change. Reported as
        // a bare retry, the drift check read it as the same inputs producing
        // new bytes and blamed "an upgraded renderer, a changed helper".
        assert.doesNotMatch(cycle, /output-drift/,
            `the repairing save was reported as drift\n${cycle}`)
        alive(watcher)
    })

    it('settles once it has recovered', async () => {
        // The failure record is cleared by the render that succeeded; one
        // left behind re-dispatches the page on every cycle after this.
        const mark = watcher.output.length
        const before = watcher.completions()
        await writeFile(path.join(workdir, 'documents/b.md'), '---\nlayout: plain\ntitle: again\n---\n')
        assert.ok(await watcher.waitFor('Mikser completed', before + 1), watcher.output)
        assert.match(watcher.output.slice(mark), /Rendered: 1\b/, watcher.output.slice(mark))
    })
})

describe('a lifecycle hook that throws while --watch is running', () => {
    // Not every failing hook is a sidecar a plugin can catch on its own
    // behalf. Whatever a plugin throws out of a phase, the watcher has to
    // outlive the cycle it broke, say where it broke, and run the next one.
    const PLUGIN = `
import { existsSync } from 'node:fs'
export function thrower() {
    return ({ onBeforeRender }) => {
        onBeforeRender(async () => {
            if (existsSync(new URL('./THROW', import.meta.url))) throw new Error('the hook exploded')
        })
    }
}
`
    const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { thrower } from './thrower.js'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), thrower()] }
`
    const workdir = freshWorkdir('watch-hook-throw')
    const page = (name) => readFile(path.join(workdir, `out/${name}/index.html`), 'utf8')
    let watcher

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'thrower.js': PLUGIN,
            'layouts/page.html.hbs': '<h1>{{entity.meta.title}}</h1>',
            'documents/a.md': '---\nlayout: page\ntitle: FIRST\n---\n',
            'documents/b.md': '---\nlayout: page\ntitle: FIRST\n---\n',
        })
        watcher = startWatcher(workdir)
        assert.ok(await watcher.waitFor('Mikser completed'), `the watcher never finished its first build\n${watcher.output}`)
    })
    after(async () => {
        await watcher?.stop()
        await cleanup(workdir)
    })

    it('survives the cycle and names the phase that broke', async () => {
        await writeFile(path.join(workdir, 'THROW'), '')
        await writeFile(path.join(workdir, 'documents/a.md'), '---\nlayout: page\ntitle: SECOND\n---\n')
        assert.ok(await watcher.waitFor('cycle-failed'),
            `the failed cycle was not reported\n${watcher.output}`)
        assert.match(watcher.output, /beforeRender/, 'the report must say which phase threw')
        assert.match(watcher.output, /the hook exploded/)
        assert.doesNotMatch(watcher.output, /Unhandled rejection/,
            `the cycle's failure must be caught where the cycle is started, not by the floor\n${watcher.output}`)
        alive(watcher)
    })

    it('runs the next cycle, and does not lose the work the failed one dropped', async () => {
        // a.md's edit was journalled by the cycle that threw. Nothing about
        // a.md changes again, so if the failed cycle consumed its entry, a
        // green build follows and a.md serves FIRST forever.
        await rm(path.join(workdir, 'THROW'))
        const before = watcher.completions()
        await writeFile(path.join(workdir, 'documents/b.md'), '---\nlayout: page\ntitle: SECOND\n---\n')
        assert.ok(await watcher.waitFor('Mikser completed', before + 1),
            `no cycle completed after the failure\n${watcher.output}`)
        assert.match(await page('b'), /SECOND/)
        assert.match(await page('a'), /SECOND/,
            `the edit made during the failed cycle never rendered\n${watcher.output}`)
        alive(watcher)
    })
})

describe('a rejection nobody awaits while --watch is running', () => {
    // The floor under the ones nobody has found yet: a plugin's detached
    // promise. It never worked from the CLI — the handler read --watch
    // before the CLI had been parsed — so the first unhandled rejection a
    // watcher met was always fatal.
    const PLUGIN = `
import { existsSync } from 'node:fs'
export function detacher() {
    return ({ onProcessed }) => {
        onProcessed(async () => {
            if (existsSync(new URL('./DETACH', import.meta.url))) {
                Promise.reject(new Error('nobody awaited this'))
            }
        })
    }
}
`
    const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { detacher } from './detacher.js'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), detacher()] }
`
    const workdir = freshWorkdir('watch-detached-rejection')
    let watcher

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'detacher.js': PLUGIN,
            'layouts/page.html.hbs': '<h1>{{entity.meta.title}}</h1>',
            'documents/a.md': '---\nlayout: page\ntitle: FIRST\n---\n',
        })
        watcher = startWatcher(workdir)
        assert.ok(await watcher.waitFor('Mikser completed'), `the watcher never finished its first build\n${watcher.output}`)
    })
    after(async () => {
        await watcher?.stop()
        await cleanup(workdir)
    })

    it('is reported with its stack and the watcher keeps running', async () => {
        await writeFile(path.join(workdir, 'DETACH'), '')
        await writeFile(path.join(workdir, 'documents/a.md'), '---\nlayout: page\ntitle: SECOND\n---\n')
        assert.ok(await watcher.waitFor('the watcher is still running'),
            `the rejection was not reported as survivable\n${watcher.output}`)
        assert.match(watcher.output, /nobody awaited this/)
        alive(watcher)
    })

    it('runs the next cycle', async () => {
        await rm(path.join(workdir, 'DETACH'))
        const before = watcher.completions()
        await writeFile(path.join(workdir, 'documents/a.md'), '---\nlayout: page\ntitle: THIRD\n---\n')
        assert.ok(await watcher.waitFor('Mikser completed', before + 1),
            `no cycle completed after the rejection\n${watcher.output}`)
        assert.match(await readFile(path.join(workdir, 'out/a/index.html'), 'utf8'), /THIRD/)
        alive(watcher)
    })
})
