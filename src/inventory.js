// What this mikser is made of.
//
// An agent arriving at a site can see what it may write and what it may not,
// and nothing at all about the machine doing the writing: which plugins are
// installed, what each one is for, or where to read about them. So it reasons
// about a system it cannot name — and a capability like `drive:layouts` means
// nothing until you know a plugin called mikser-io-drive exists and what it
// does.
//
// DERIVED, not declared. Every plugin already carries a description, a
// homepage and a repository in its own package.json, kept current because npm
// publishes from it. A second hand-written summary somewhere else would be one
// more thing to drift, and the first time it drifted it would be describing a
// plugin that had changed underneath it.

import path from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import runtime from './runtime.js'

// A repository field is a string or an object, and either may be a shorthand
// or a git URL. Normalised to something a reader can open.
function repositoryUrl(repository) {
    const raw = typeof repository === 'string' ? repository : repository?.url
    if (!raw) return null
    const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw)
    if (shorthand) return `https://github.com/${shorthand[1]}`
    return raw
        .replace(/^git\+/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/\.git$/, '')
}

// Every mikser package INSTALLED beside this one, described.
//
// Installed, and nothing more. This list used to carry an `active` flag,
// derived by probing whatever surfaces a plugin happened to expose — a route
// here, a CLI flag there. Two things were wrong with it and only the second
// was dangerous.
//
// The probe went stale silently: it tested `runtime.options.layouts`, which
// stopped being layouts' API object two majors ago and is now the `--layouts`
// folder flag, so layouts read as inactive on every site that did not pass a
// flag it has no reason to pass. It also tested `runtime.options.preview` for
// a package, `mikser-io-preview`, that does not exist.
//
// And the flag was three-valued in code and two-valued in its contract:
// present meant running, absent meant EITHER not running or not detectable,
// and an agent told to read it "to know what the system can do" could only
// read absence as off. On a real site that said no schema validation and no
// git sync while both were running — and git sync is the only route by which
// an agent's own edit reaches the repository.
//
// What is running is now answered by the runtime recording what it loads, in
// plugins.js. This answers a different and still useful question: what is on
// disk, what version, and where to read about it.
export function inventory({ workingFolder = runtime.options?.workingFolder } = {}) {
    const root = path.join(workingFolder ?? '.', 'node_modules')
    let names = []
    try {
        names = readdirSync(root).filter(n => n === 'mikser-io' || n.startsWith('mikser-io-'))
    } catch {
        return []
    }

    const plugins = []
    for (const name of names.sort()) {
        try {
            const manifest = JSON.parse(readFileSync(path.join(root, name, 'package.json'), 'utf8'))
            const repository = repositoryUrl(manifest.repository)
            plugins.push({
                name,
                version: manifest.version ?? null,
                ...(manifest.description ? { summary: manifest.description } : {}),
                ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
                ...(repository ? { repository } : {}),
                npm: `https://www.npmjs.com/package/${name}`,
            })
        } catch { /* unreadable manifest — say nothing rather than something wrong */ }
    }
    return plugins
}

// What this runtime LOADED — the answer to "what is running".
//
// Read from the record plugins.js keeps as it loads, not derived from
// surfaces afterwards. Every loaded plugin appears, including one that named
// nothing: `package: null` means "running, and did not say what it is", which
// is a different statement from not running and must never be collapsed into
// one. Nothing here is ever absent because it could not be detected — a plugin
// that is loaded is in this list.
export function loadedPlugins({ workingFolder = runtime.options?.workingFolder } = {}) {
    const root = path.join(workingFolder ?? '.', 'node_modules')
    const versionOf = (name) => {
        if (!name) return null
        try {
            return JSON.parse(readFileSync(path.join(root, name, 'package.json'), 'utf8')).version ?? null
        } catch { return null }
    }
    return (runtime.plugins ?? []).map(entry => ({
        ...entry,
        ...(entry.package ? { version: versionOf(entry.package) } : {}),
    }))
}
