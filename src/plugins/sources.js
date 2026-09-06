// Register build inputs — styles/, js/ — as catalog entities.
//
// The gap this fills: a site that bundles assets needs a layout sidecar to
// read those files. Reading them with `fs` works for a one-shot build and
// SILENTLY breaks watch — the engine has no dependency on a file it never
// saw, so editing styles/sections/hero.css rebuilds nothing and the page is
// stale with nothing saying so. The first build is correct, which is what
// makes it expensive: the mistake only surfaces later as "why didn't my edit
// take effect", and the obvious workaround is the broken one.
//
// Registered as entities instead, a sidecar reads them with findEntities(),
// whose queries are recorded into the render's refClosure — so touching one
// part re-renders the bundle and nothing else, by the same mechanism that
// re-renders a page when a document it references changes.
//
// Deliberately NOT the `files` plugin: these are inputs, not output. Nothing
// is linked into out/, no meta.url is stamped, and they take no part in
// ADR-0011 served-path resolution. A stylesheet part is not a thing the site
// serves; it is a thing the site is built from.
//
// Named `sources` rather than `inputs` because `entity.inputs` already means
// something adjacent but different — bytes an entity's output depends on
// without them being entities at all (see inputHashOf). Two spellings of
// "input" meaning two things would be worse than a slightly generic name.
import path from 'node:path'
import { useSource } from '../source.js'

export function sources(options = {}) {
    const collections = Object.entries(options)
    return (core) => {
        const { useLogger } = core
        if (!collections.length) {
            // No collections is a legitimate config (a flag turned them all
            // off); nothing to register, and nothing to complain about. Still
            // names itself: the plugin IS loaded, and a config that turned its
            // collections off must not make it look undetectable.
            return { module: import.meta.url }
        }
        for (const [collection, config] of collections) {
            const {
                folder = collection,
                extensions = ['*'],
                ignore = [],
                // Content is the point — a sidecar bundling CSS needs the
                // bytes, not just the path. Overridable for a collection
                // that only needs to be *known* (an image manifest, say).
                content = true,
                load,
                // Code-shaped, so the extension stays in `id` (two parts of
                // the same name in different languages must not collide) and
                // `name` keeps the folder-relative path without it.
                stripExtensionFromId = false,
            } = config ?? {}

            useSource(core, {
                collection,
                type: 'source',
                folder,
                extensions,
                ignore,
                content,
                stripExtensionFromId,
                load: load ?? (async () => ({})),
                progress: `${collection.replace(/^./, c => c.toUpperCase())} import`,
            })
        }
        useLogger?.()?.debug('Sources registered: %s', collections.map(([c]) => c).join(', '))
        // Names this package to the runtime's loaded-plugin record, so ping
        // reports it as running rather than as undetectable.
        return { module: import.meta.url }
    }
}

export default sources
