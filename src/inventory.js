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

// Which plugins are actually RUNNING, as opposed to merely installed.
//
// The distinction is the useful half: a package in node_modules that no config
// loads explains nothing about the site's behaviour, and an agent told
// otherwise will look for a feature that is not switched on.
function activeNames() {
    const active = new Set()
    const named = (short) => (short.startsWith('mikser-io') ? short : `mikser-io-${short}`)

    // Every plugin that mounts a route already names itself there — the
    // strongest signal available, and one that stays correct as plugins are
    // added, because registerRoute requires it.
    for (const route of runtime.routes ?? []) {
        if (route?.plugin) active.add(named(route.plugin))
    }
    // Renderers and postprocessors are registered by name rather than by
    // package, and the package name is that name in a fixed shape.
    for (const name of runtime.renderers?.keys() ?? []) active.add(`mikser-io-render-${name}`)
    for (const name of runtime.postprocessors?.keys() ?? []) active.add(`mikser-io-post-${name}`)
    // A lifecycle plugin that mounts nothing is recognised by the surface it
    // publishes on the runtime.
    if (runtime.options?.layouts) active.add('mikser-io-layouts')
    if (runtime.options?.preview) active.add('mikser-io-preview')
    // The engine itself is always running; saying otherwise would be odd.
    active.add('mikser-io')
    return active
}

// Every mikser package installed beside this one, described.
//
// `active` is reported only where it can be established: a lifecycle plugin
// that publishes nothing on the runtime cannot be detected, and saying `false`
// for it would be a claim rather than an absence of one.
export function inventory({ workingFolder = runtime.options?.workingFolder } = {}) {
    const root = path.join(workingFolder ?? '.', 'node_modules')
    let names = []
    try {
        names = readdirSync(root).filter(n => n === 'mikser-io' || n.startsWith('mikser-io-'))
    } catch {
        return []
    }

    const active = activeNames()
    const plugins = []
    for (const name of names.sort()) {
        try {
            const manifest = JSON.parse(readFileSync(path.join(root, name, 'package.json'), 'utf8'))
            const repository = repositoryUrl(manifest.repository)
            plugins.push({
                name,
                version: manifest.version ?? null,
                ...(manifest.description ? { summary: manifest.description } : {}),
                ...(active.has(name) ? { active: true } : {}),
                ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
                ...(repository ? { repository } : {}),
                npm: `https://www.npmjs.com/package/${name}`,
            })
        } catch { /* unreadable manifest — say nothing rather than something wrong */ }
    }
    return plugins
}
