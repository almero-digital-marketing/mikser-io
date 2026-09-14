#!/usr/bin/env node
// publish.mjs — release the mikser family, in an order that can actually work.
//
// Referenced by each package as `npm run publish:workspace`
// (`node ../publish.mjs --only <name>`), and runnable bare to release
// everything that is stale.
//
// Publishing here means PUSHING A TAG. The packages publish from CI through
// npm trusted publishing (OIDC), so there is no token on a laptop to leak and
// nothing to rotate — `.github/workflows/publish.yml` does the actual
// `npm publish`. `--direct` overrides that for the rare case where CI cannot
// (a first publish, which trusted publishing cannot do because the package
// does not exist yet).
//
// Four things this exists to prevent, each of which happened:
//
//   1. THE DEPENDENCY RACE. 36 tags pushed at once meant every package's CI
//      ran `npm install` against a registry where its siblings were not there
//      yet. Nine failed with "No matching version found for
//      mikser-io-render-liquid@^11.0.1". Alphabetical order does not help:
//      assets sorts before layouts and depends on it. So the order here is
//      topological, and each package is WAITED FOR before its dependents go.
//
//   2. THE PROPAGATION LAG. npm answers "+ pkg@1.2.3" and then says "Your
//      package is being processed and may take a few minutes to become
//      available". A dependent pushed inside that window fails exactly like a
//      dependent pushed too early. Waiting on the registry, not on the run,
//      is the only signal that means anything.
//
//   3. THE BURNED VERSION. A version that was published and then unpublished
//      can NEVER be reused — npm keeps it in `time` and refuses the PUT
//      forever. mikser-io@11.0.0 was burned this way, and the whole family
//      had to move to 11.0.1. Detected up front, because finding out at
//      publish time means half a release has already gone out.
//
//   4. THE UNSATISFIABLE RANGE. Two packages declared `mikser-io@^10.0.0`
//      while importing exports that only exist in 10.14.0. It never bit
//      locally, because a workspace resolves siblings from disk whatever the
//      range says — CI was the first thing ever to read it, and every test
//      file failed at import. Checked before anything is pushed.
//
// Usage:
//   node publish.mjs                 release everything stale
//   node publish.mjs --dry           report the plan, touch nothing
//   node publish.mjs --only a,b      restrict to these packages (and report
//                                    any of their dependencies that are stale)
//   node publish.mjs --direct        npm publish from here instead of tagging
//   node publish.mjs --force         push a tag even if the tree is dirty
//   node publish.mjs --timeout 600   seconds to wait for one package (default 900)
//   node publish.mjs --all           release every stale package, including
//                                    ones whose only change is a version bump
//
// THIS DOES NOT BUMP VERSIONS. A package owns its own number:
//
//   cd mikser-io-render-eta && npm version patch    # or minor / major
//   node ../publish.mjs
//
// `npm version` writes package.json, commits and tags in one step, which is
// exactly what this then pushes.
//
// Nobody can pick the right number except whoever wrote the change. A tool
// can see THAT shipped files moved; it cannot see whether they moved in a way
// a consumer must be told about. The same one-line diff is a patch when it
// fixes a typo in a log message and a major when it renames an export, and
// nothing in the diff distinguishes them. A tool that guessed would be wrong
// silently and in the direction that hurts — a break released as a patch.
//
// So this reports which packages are waiting for a bump, and leaves the
// judgement where the knowledge is.
//
// UNTOUCHED PACKAGES ARE LEFT ALONE. A package is released when its own
// SHIPPED files changed since the version currently on the registry — not
// because a sibling moved, and not because someone bumped its number. Every
// in-family range is a caret, so a dependent already resolves a newer
// dependency without republishing; 36 republishes of byte-identical code to
// keep one number exactly equal is a cost paid on every patch forever.
//
// "Shipped" is what `npm pack` would put in the tarball, not what is in the
// folder: a change to test/, docs/ or .github/ is not a release. And a
// package whose published version has no matching tag is UNKNOWN, never
// "unchanged" — a check that cannot see is not a check that passed.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import process from 'node:process'
import { releaseDecision } from './release-decision.mjs'
import { mapConcurrent } from './concurrent.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const DRY = flag('dry')
const DIRECT = flag('direct')
const FORCE = flag('force')
const TIMEOUT_MS = Number(value('timeout', 900)) * 1000
// How long between registry checks while waiting for a publish to appear.
// The wait is dominated by the CI run, so polling faster than this buys
// nothing and only adds requests.
const POLL_MS = 15_000
const ALL = flag('all')
const ONLY = flag('only')
    ? new Set(String(value('only', '')).split(',').map(s => s.trim()).filter(Boolean))
    : null

// The workspace root: two levels up from mikser-io/tools/. Resolved from this
// file rather than from cwd, so the script behaves the same whether it is run
// from the root, from a package, or through a package's `publish:workspace`.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const say = (...args) => console.log(...args)
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// ── discovery ───────────────────────────────────────────────────────────────
// Scanned, never listed. A hand-kept list goes stale silently, and the whole
// point of this file is to not be the thing that goes stale.
function discover() {
    const found = new Map()
    for (const entry of readdirSync(ROOT)) {
        const manifestPath = path.join(ROOT, entry, 'package.json')
        if (!existsSync(manifestPath)) continue
        let manifest
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
        if (!manifest.name?.startsWith('mikser-io')) continue
        if (manifest.private) continue
        const deps = new Set()
        for (const block of ['dependencies', 'peerDependencies', 'devDependencies']) {
            for (const [name, range] of Object.entries(manifest[block] ?? {})) {
                // A file: link is a workspace convenience and says nothing
                // about what a consumer will install.
                if (name.startsWith('mikser-io') && !String(range).startsWith('file:')) {
                    deps.add(name)
                }
            }
        }
        found.set(manifest.name, {
            name: manifest.name,
            dir: path.join(ROOT, entry),
            version: manifest.version,
            deps: [...deps],
            ranges: Object.fromEntries(
                ['dependencies', 'peerDependencies', 'devDependencies'].flatMap(block =>
                    Object.entries(manifest[block] ?? {})
                        .filter(([n, r]) => n.startsWith('mikser-io') && !String(r).startsWith('file:'))
                        .map(([n, r]) => [n, r]))),
            hasGit: existsSync(path.join(ROOT, entry, '.git')),
        })
    }
    return found
}

// ── ordering ────────────────────────────────────────────────────────────────
// Depth-first, dependencies emitted before dependents. The family graph is a
// DAG today; a cycle would be a real configuration problem, so it is reported
// rather than silently broken by dropping an edge.
function topoSort(packages) {
    const order = []
    const state = new Map()
    const cycles = []
    const visit = (name, trail) => {
        if (state.get(name) === 'done') return
        if (state.get(name) === 'open') {
            cycles.push([...trail.slice(trail.indexOf(name)), name].join(' -> '))
            return
        }
        state.set(name, 'open')
        for (const dep of packages.get(name)?.deps ?? []) {
            if (packages.has(dep)) visit(dep, [...trail, name])
        }
        state.set(name, 'done')
        order.push(name)
    }
    for (const name of [...packages.keys()].sort()) visit(name, [])
    return { order, cycles }
}

// ── the registry, asked directly ────────────────────────────────────────────
// Not `npm view`: it answers from a cache that has served a version behind
// reality more than once. This reads the registry document itself.
async function registry(name) {
    try {
        const response = await fetch(`https://registry.npmjs.org/${name}`, {
            headers: { accept: 'application/json' },
        })
        if (response.status === 404) return { exists: false, versions: {}, time: {}, latest: null }
        if (!response.ok) return null
        const doc = await response.json()
        return {
            exists: true,
            versions: doc.versions ?? {},
            time: doc.time ?? {},
            latest: doc['dist-tags']?.latest ?? null,
        }
    } catch {
        return null       // unreachable is UNKNOWN, never "fine"
    }
}

// A version npm will refuse forever: it appears in `time` (it was published)
// but not in `versions` (it was unpublished). npm never lets the number back.
const isBurned = (doc, version) =>
    Boolean(doc?.time?.[version]) && !doc?.versions?.[version]

const satisfiesCaret = (range, version) => {
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
    if (!m) return null                        // not a caret — do not guess
    const [, rMajor, rMinor, rPatch] = m.map(Number)
    const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    if (!v) return null
    const [, major, minor, patch] = v.map(Number)
    if (major !== rMajor) return false
    if (minor !== rMinor) return minor > rMinor
    return patch >= rPatch
}

// What a release of this package would actually contain. `npm pack` decides,
// because `files`, .npmignore and .gitignore all feed into it and reproducing
// that logic here would be a second implementation to drift.
// Answers are cached per directory, because the decision below can ask twice
// for one package (against `latest`, then against its own version) and the
// file list cannot have changed in between.
const packCache = new Map()

function shippedFiles(dir) {
    if (packCache.has(dir)) return packCache.get(dir)
    try {
        const out = execFileSync('npm', ['pack', '--dry-run', '--json'],
            { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const files = JSON.parse(jsonTail(out))[0].files.map(f => f.path)
        packCache.set(dir, files)
        return files
    } catch {
        packCache.set(dir, null)
        return null              // cannot tell — the caller must not guess
    }
}

// Fill the cache for several packages at once.
//
// This is the whole cost of the pre-flight. `npm pack --dry-run` is a 240ms
// subprocess and the decisions need one apiece, so thirty-eight in sequence
// were nine of the ten seconds the tool spent before it did anything.
//
// It has to be a prefetch rather than concurrency around the decisions
// themselves: `shippedFiles` is execFileSync, and a synchronous subprocess
// blocks the event loop, so async workers around it run strictly one after
// another. Measured — wrapping the decision loop in a concurrent map changed
// the total by nothing at all.
//
// For every package, --only included. The tempting filter is "just the ones
// being released", but `--only` is documented as restricting the RELEASE and
// reporting the rest, and releaseDecision answers "changed since X — needs a
// bump" for an already-published package before it ever looks at `wanted`.
// So the pack happens for all of them either way; the only question is
// whether it happens concurrently. Filtering here left `--only` at ten
// seconds while the bare run dropped to two and a half — measured, after
// assuming otherwise.
async function prefetchShippedFiles(dirs, limit = 8) {
    const execFile = promisify(execFileCb)
    await mapConcurrent(dirs.filter(d => !packCache.has(d)), limit, async (dir) => {
        try {
            const { stdout } = await execFile('npm', ['pack', '--dry-run', '--json'],
                { cwd: dir, encoding: 'utf8' })
            packCache.set(dir, JSON.parse(jsonTail(stdout))[0].files.map(f => f.path))
        } catch {
            // Leave it uncached: the synchronous path will try again and get
            // the same answer, and a failure here must not become "nothing
            // shipped", which would read as "nothing changed".
        }
    })
}

// npm pack --json puts JSON on stdout, and a `prepack` script's own output
// lands there too — ahead of it. A package that builds an artefact before it
// packs (mikser-io-mcp-app bundles its app shell) therefore returned a body
// starting `vite v7.3.6 building…`, JSON.parse threw, and the release was
// reported as UNDETERMINED and skipped. The package was correct to be
// skipped rather than guessed at, but the cause was noise, not ambiguity.
//
// So: take the last thing in the output that parses as JSON. Scanning from
// the end rather than the first `[` because build output can contain brackets
// of its own.
function jsonTail(out) {
    const start = out.lastIndexOf('\n[')
    return start === -1 ? out : out.slice(start + 1)
}

// Did anything a consumer receives change since the published version?
//
// Returns true / false / null, and null means UNDETERMINED: no tag for the
// published version, or npm pack could not answer. The caller reports it and
// leaves the package alone rather than treating silence as "nothing changed".
function changedSincePublished(pkg, publishedVersion) {
    if (!pkg.hasGit || !publishedVersion) return null
    const tag = `v${publishedVersion}`
    try {
        // An uncommitted change is invisible to `git diff <tag>..HEAD`, so a
        // dirty tree would be reported as "unchanged" — the one wrong answer
        // this must never give. It is undetermined instead, and the release
        // step refuses a dirty tree anyway.
        if (git(pkg.dir, 'status', '--porcelain')) return null
        if (!git(pkg.dir, 'tag', '-l', tag)) return null
        const changed = git(pkg.dir, 'diff', '--name-only', `${tag}..HEAD`)
            .split('\n').map(l => l.trim()).filter(Boolean)
        if (!changed.length) return false
        const ships = shippedFiles(pkg.dir)
        if (ships === null) return null
        const shipped = new Set(ships)
        // package.json always ships, and a lone version bump inside it is
        // exactly what this is here to ignore — so it does not count on its
        // own. Any other shipped file changing does.
        const meaningful = changed.filter(f => shipped.has(f) && f !== 'package.json')
        return meaningful.length > 0
    } catch {
        return null
    }
}

async function main() {
    const packages = discover()
    if (!packages.size) {
        console.error('No mikser packages found beside this script. Is it in the workspace root?')
        process.exit(2)
    }
    const { order, cycles } = topoSort(packages)
    if (cycles.length) {
        console.error('Dependency cycle(s), so there is no order that can work:')
        for (const cycle of cycles) console.error('  ' + cycle)
        process.exit(2)
    }

    say(`${packages.size} packages, ordered by dependency.\n`)

    // ── pre-flight ──────────────────────────────────────────────────────────
    // Everything that can be known before anything moves.
    //
    // Fetched concurrently, though measurement says this was never the cost:
    // fetch keeps the connection alive, so thirty-eight sequential reads of
    // one host ran at about 30ms each. Worth 0.3s of the ten seconds this
    // phase took. The nine seconds were `npm pack`, below.
    //
    // Every package is still fetched, even with --only. The temptation is to
    // skip the rest and save the requests, but the checks below are exactly
    // what this tool exists for: the burned-version check and the in-family
    // range check both need the whole family's published state, and the
    // second is reason 4 in the header — two packages declaring
    // `mikser-io@^10.0.0` while importing 10.14.0 exports, which never bit
    // locally because a workspace resolves siblings from disk. Narrowing the
    // pre-flight to the package being released would take that away to save
    // latency that concurrency removes anyway.
    //
    // Bounded, because forty simultaneous requests is how a registry starts
    // answering 429 — and an unreachable registry here exits rather than
    // guessing, so rate-limiting ourselves would turn a speedup into a
    // refusal to release.
    const docs = new Map(await mapConcurrent(order, 8,
        async (name) => [name, await registry(name)]))

    const blockers = []
    const unreachable = []
    for (const name of order) {
        const pkg = packages.get(name)
        const doc = docs.get(name)
        if (doc === null) { unreachable.push(name); continue }
        if (isBurned(doc, pkg.version)) {
            blockers.push(`${name}@${pkg.version} was published and unpublished on `
                + `${String(doc.time[pkg.version]).slice(0, 10)}. npm never allows that number `
                + `again — choose another version.`)
        }
        // Will each in-family range be satisfiable once this release lands?
        for (const [dep, range] of Object.entries(pkg.ranges)) {
            const target = packages.get(dep)
            if (!target) continue
            const ok = satisfiesCaret(range, target.version)
            if (ok === false) {
                blockers.push(`${name} requires ${dep}@${range}, but ${dep} is at `
                    + `${target.version}. CI installs from the registry, so this fails there `
                    + `even though the workspace resolves it from disk.`)
            }
        }
    }
    if (unreachable.length) {
        console.error('Could not reach the registry for: ' + unreachable.join(', '))
        console.error('Refusing to guess what is published. Nothing was done.')
        process.exit(2)
    }
    if (blockers.length) {
        console.error('Blocked before anything moved:\n')
        for (const b of blockers) console.error('  • ' + b)
        process.exit(1)
    }

    // ── the plan ────────────────────────────────────────────────────────────
    //
    // Decided CONCURRENTLY, which is where the time actually was. Each
    // decision that has to look costs an `npm pack --dry-run` — 240ms of
    // subprocess apiece, measured — and thirty-eight of those in a row is
    // nine of the ten seconds this tool spent before doing anything.
    //
    // Safe to run together because a decision only READS: its own package's
    // git state and file list, plus the registry document already fetched
    // above. Nothing here writes, and nothing depends on another package's
    // decision — the topological order governs the RELEASE sequence further
    // down, not this.
    //
    // The thunks stay thunks. They are not an optimisation that concurrency
    // replaces: they are what stops the tool packing a package whose answer
    // cannot change the outcome, and with --only that is most of them.
    // Everything the decisions will pack, packed at once.
    await prefetchShippedFiles(order.map(name => packages.get(name).dir))

    const undetermined = []
    const decided = await mapConcurrent(order, 8, async (name) => {
        const pkg = packages.get(name)
        const doc = docs.get(name)
        const published = Boolean(doc.versions[pkg.version])
        const wanted = !ONLY || ONLY.has(name)
        // Thunks, not values: each of these costs a git diff plus an
        // `npm pack`, and the decision only asks when the answer can change
        // the outcome.
        const { skip, undetermined: cannotTell } = releaseDecision({
            version: pkg.version,
            latest: doc.latest,
            isPublished: published,
            wanted,
            hasGit: pkg.hasGit,
            all: ALL,
            direct: DIRECT,
            changedSinceLatest: () => changedSincePublished(pkg, doc.latest),
            changedSinceOwn: () => changedSincePublished(pkg, pkg.version),
            isDirty: () => Boolean(pkg.hasGit && git(pkg.dir, 'status', '--porcelain')),
        })
        return { name, cannotTell, entry: { ...pkg, published, skip } }
    })
    // Back into topological order for everything downstream — mapConcurrent
    // preserves input order, and the release loop depends on it.
    const plan = []
    for (const { name, cannotTell, entry } of decided) {
        if (cannotTell) undetermined.push(name)
        plan.push(entry)
    }

    const releasing = plan.filter(p => !p.skip)
    for (const p of plan) {
        const mark = p.skip ? '  ·' : '  →'
        say(`${mark} ${p.name.padEnd(30)} ${p.version.padEnd(10)} ${p.skip ?? 'will release'}`)
    }
    say('')
    if (undetermined.length) {
        say('Could not determine what changed for: ' + undetermined.join(', '))
        say('Left alone. Pass --all to release them anyway.\n')
    }
    if (!releasing.length) { say('Nothing to release.'); return }
    if (DRY) { say(`--dry: ${releasing.length} package(s) would be released, in the order above.`); return }

    // ── release ─────────────────────────────────────────────────────────────
    const failed = []
    for (const pkg of releasing) {
        // A dependency that failed earlier makes this one unreleasable: its CI
        // would install a version that is not there. Stop rather than add a
        // second failure whose cause is the first.
        const blockedBy = pkg.deps.filter(d => failed.includes(d))
        if (blockedBy.length) {
            say(`  ✗ ${pkg.name}: skipped, depends on ${blockedBy.join(', ')} which did not publish`)
            failed.push(pkg.name)
            continue
        }

        if (!FORCE && pkg.hasGit && git(pkg.dir, 'status', '--porcelain')) {
            say(`  ✗ ${pkg.name}: working tree is dirty — commit first, or pass --force`)
            failed.push(pkg.name)
            continue
        }

        try {
            if (DIRECT) {
                say(`  → ${pkg.name}: npm publish`)
                execFileSync('npm', ['publish', '--access', 'public'], { cwd: pkg.dir, stdio: 'inherit' })
            } else {
                const tag = `v${pkg.version}`
                const tags = git(pkg.dir, 'tag', '-l', tag)
                if (!tags) git(pkg.dir, 'tag', tag)
                say(`  → ${pkg.name}: pushing ${tag}`)
                git(pkg.dir, 'push', 'origin', 'HEAD')
                git(pkg.dir, 'push', 'origin', tag)
            }
        } catch (err) {
            say(`  ✗ ${pkg.name}: ${err.message.split('\n')[0]}`)
            failed.push(pkg.name)
            continue
        }

        // Wait for the REGISTRY, not for the CI run. A green run whose version
        // is not yet installable is exactly as useless to a dependent as a
        // failed one.
        const deadline = Date.now() + TIMEOUT_MS
        let live = false
        while (Date.now() < deadline) {
            // Ask FIRST, then wait. Sleeping before the first check charged
            // fifteen seconds to every package, including one whose CI had
            // already finished — and at four packages in a release that is a
            // minute of nothing.
            const doc = await registry(pkg.name)
            if (doc?.versions?.[pkg.version]) { live = true; break }
            await new Promise(r => setTimeout(r, POLL_MS))
        }
        if (live) {
            say(`  ✓ ${pkg.name}@${pkg.version} is live`)
        } else {
            say(`  ✗ ${pkg.name}@${pkg.version} did not appear within `
                + `${TIMEOUT_MS / 1000}s — check its workflow run`)
            failed.push(pkg.name)
        }
    }

    say('')
    const released = releasing.length - failed.length
    say(`released ${released}/${releasing.length}`)
    if (failed.length) {
        say('failed: ' + failed.join(', '))
        process.exit(1)
    }
}

await main()
