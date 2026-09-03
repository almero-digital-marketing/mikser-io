// What this build actually wrote, as one comparable number.
//
// Proving an upgrade moved no bytes is the check every mikser project needs,
// and it is the one thing a shell script cannot compute correctly from
// outside. A real one, written twice and wrong both times, hit all of this:
//
//   - `find out -type f` does NOT descend into a symlink, and files() emits by
//     symlinking while assets symlinks the whole derivatives tree in. Every
//     "byte-identical" it printed was a statement about html, css and js only,
//     with the derivatives silently excluded.
//   - the derivatives live wherever `assetsFolder` says, which is config the
//     script had to re-derive.
//   - hashing per directory block meant the order depended on the order the
//     blocks came back, and two runs over byte-identical trees hashed
//     differently — a false CHANGED, which sends someone hunting a regression
//     that never happened.
//   - which presets are cheap to re-render (sharp, an npm dependency that an
//     upgrade CAN change) and which are not (ffmpeg, a host binary it cannot)
//     had to be inferred by grepping the preset sources.
//
// The engine knows all four without inferring anything. So it answers, and the
// script that orchestrates the upgrade keeps only the part that is genuinely
// its own: talking to npm.

import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, lstat } from 'node:fs/promises'
import { globby } from 'globby'
import runtime from './runtime.js'

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

// Streamed, not read into memory. A derivatives tree is the largest thing in
// the output and the reason to fingerprint at all; loading a 40MB video to
// hash it would make the check cost more than the build.
function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        createReadStream(file)
            .on('error', reject)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
    })
}

// One hash over a sorted list of `path\0contentHash` lines.
//
// The sort lives HERE and nowhere else. It used to be applied to the file list
// as well, which made this one redundant and therefore untestable — and a
// redundant guard is one that gets removed later by someone who checks that
// the tests still pass. Sorting where the hash is computed also makes each
// tree group order-independent on its own, rather than only by inheritance
// from the walk.
//
// The path is part of the input: a file that moved is a change, and a hash of
// contents alone would call a rename identical.
// Exported because these two properties — order independence and path
// sensitivity — are properties of the HASH, not of a build, and a scenario
// cannot force globby to return files in a hostile order to check them.
export function combineEntries(entries) {
    const lines = entries
        .map(({ file, hash }) => `${file}\0${hash}`)
        .sort()
        .join('\n')
    return sha256(lines)
}


// Everything the build wrote, including what it wrote through a symlink.
//
// `followSymbolicLinks: true` is the whole point — see above. `onlyFiles`
// keeps directory symlinks from being listed as entries in their own right
// while still descending through them.
export async function fingerprintOutputs() {
    const outputFolder = runtime.options?.outputFolder
    if (!outputFolder) return null

    const files = await globby('**/*', {
        cwd: outputFolder,
        followSymbolicLinks: true,
        onlyFiles: true,
        suppressErrors: true,
        dot: true,
    })

    const entries = []
    let bytes = 0
    for (const file of files) {
        const absolute = path.join(outputFolder, file)
        try {
            const info = await stat(absolute)
            bytes += info.size
            entries.push({ file, hash: await hashFile(absolute), size: info.size })
        } catch { /* vanished mid-walk — a concurrent build, not our business */ }
    }

    // Broken out per shared tree, because the parts of an output answer
    // different questions about an upgrade. A preset rendering through an npm
    // dependency (sharp) can move when that dependency does; one shelling out
    // to a host binary (ffmpeg) cannot, and re-rendering it to find that out
    // costs minutes. A caller comparing releases can hash the whole output, or
    // just the groups whose renderer an upgrade could have touched.
    //
    // The trees are found by asking the OUTPUT, not the plugin that made them.
    // A report-only command runs in an onLoaded registered when the engine is
    // imported, which is before every plugin's — so runtime.options.assets is
    // not set yet and reading it grouped nothing at all. The filesystem knows
    // the same fact and knows it in every phase: a top-level entry that is a
    // symlink to a directory is a tree emitted from elsewhere, which is what
    // both assets and resources produce and what `find` refuses to descend
    // into.
    const groups = {}
    for (const name of new Set(entries.map(e => e.file.split('/')[0]))) {
        const top = path.join(outputFolder, name)
        let linked = false
        try { linked = (await lstat(top)).isSymbolicLink() } catch { continue }
        if (!linked) continue
        const prefix = `${name}/`
        for (const entry of entries) {
            if (!entry.file.startsWith(prefix)) continue
            // `<tree>/<group>/…` — the preset, for an assets tree. A tree
            // holding files directly is reported under its own name.
            const rest = entry.file.slice(prefix.length).split('/')
            const label = rest.length > 1 ? `${name}/${rest[0]}` : name
            const group = (groups[label] ??= { files: [], bytes: 0 })
            group.files.push(entry)
            group.bytes += entry.size
        }
    }
    const trees = groups

    return {
        output: { hash: combineEntries(entries), files: entries.length, bytes },
        trees: Object.fromEntries(
            Object.entries(trees)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, group]) => [name, {
                    hash: combineEntries(group.files), files: group.files.length, bytes: group.bytes,
                }])),
    }
}
