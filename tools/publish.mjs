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
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

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
function shippedFiles(dir) {
    try {
        const out = execFileSync('npm', ['pack', '--dry-run', '--json'],
            { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return JSON.parse(out)[0].files.map(f => f.path)
    } catch {
        return null              // cannot tell — the caller must not guess
    }
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
    const docs = new Map()
    for (const name of order) docs.set(name, await registry(name))

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
    const plan = []
    const undetermined = []
    for (const name of order) {
        const pkg = packages.get(name)
        const doc = docs.get(name)
        const published = Boolean(doc.versions[pkg.version])
        const wanted = !ONLY || ONLY.has(name)
        // Only asked when it can change the answer: an unpublished version is
        // being released regardless of what the diff says.
        // The change check only governs a PATCH. A major or minor bump is a
        // deliberate release decision — it is how the family aligned on 11 —
        // and second-guessing it by diffing would refuse the very release
        // someone just chose to make. Only same-major.minor successors have to
        // prove they changed something, which is exactly the churn this
        // prevents: 36 republishes because one number moved.
        const line = (v) => String(v ?? '').split('.').slice(0, 2).join('.')
        const samePatchLine = doc.latest && line(pkg.version) === line(doc.latest)
        const touched = published || ALL || !samePatchLine
            ? null
            : changedSincePublished(pkg, doc.latest)
        if (touched === null && !published && !ALL && samePatchLine) undetermined.push(name)

        let skip = null
        if (published) {
            // Published at this number, but has the code moved since? That is
            // a package waiting for someone to decide what kind of release it
            // is — which is the judgement this tool deliberately does not make.
            const sinceOwn = changedSincePublished(pkg, pkg.version)
            skip = sinceOwn === true
                ? `changed since ${pkg.version} — needs a bump (npm version patch) before it can release`
                : `already published at ${pkg.version}`
        }
        else if (!wanted) skip = 'not in --only'
        else if (!pkg.hasGit && !DIRECT) skip = 'no git repository — cannot tag'
        else if (touched === false) skip = `unchanged since ${doc.latest} — nothing a consumer receives moved`
        else if (touched === null && samePatchLine) {
            skip = pkg.hasGit && git(pkg.dir, 'status', '--porcelain')
                ? 'uncommitted changes — commit them, then this can tell what moved'
                : `cannot tell what changed since ${doc.latest} — left alone`
        }
        plan.push({ ...pkg, published, skip })
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
            await new Promise(r => setTimeout(r, 15_000))
            const doc = await registry(pkg.name)
            if (doc?.versions?.[pkg.version]) { live = true; break }
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
