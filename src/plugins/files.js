import path from 'node:path'
import { cliOption } from '../cli.js'
import { mkdir, symlink, unlink, lstat, realpath } from 'fs/promises'
import { globby } from 'globby'
import pMap from 'p-map'
import { checksumsByCollection } from '../catalog.js'
import { sweepDeleted } from '../source.js'

export function files(options = {}) {
    return ({
        runtime,
        onLoaded,
        useLogger,
        onImport,
        createEntity,
        updateEntity,
        deleteEntity,
        watch,
        onSync,
        findEntity,
        checksum,
        trackProgress,
        updateProgress,
        constants: { ACTION },
    }) => {
        const collection = 'files'
        // The folder this plugin owns, on the command line.
        //
        // Config-only until 9.100.0, because a plugin could not declare an option
        // — so overriding it for one run meant editing the config, which is the
        // file whose checksum decides whether the catalog is still valid. A flag
        // is the difference between trying something once and invalidating
        // everything.
        //
        // CLI beats config beats default. `??` rather than `||` below: an option
        // commander did not see is undefined, and an intentional empty string is a
        // different answer than "not given".
        cliOption('--files <folder>',
            'folder of static files copied into the output by symlink, relative to the working folder (default: files)')

        const type = 'file'

        async function ensureLink(relativePath) {
            const source = path.join(runtime.options.filesFolder, relativePath)
            let uri = path.join(runtime.options.outputFolder, relativePath)
            if (options.outputFolder) uri = path.join(runtime.options.outputFolder, options.outputFolder, relativePath)
            try {
                await mkdir(path.dirname(uri), { recursive: true })
                await symlink(path.resolve(source), uri, 'file')
            } catch (err) {
                if (err.code != 'EEXIST')
                    throw err
            }
            return { uri, source }
        }

        // The goal state is "the link is not there", so a link that is
        // already gone is success, not an error. It genuinely happens: someone
        // deletes a stale one by hand, and before this the next reconciliation
        // threw on it.
        async function removeLink(relativePath) {
            let uri = path.join(runtime.options.outputFolder, relativePath)
            if (options.outputFolder) uri = path.join(runtime.options.outputFolder, options.outputFolder, relativePath)
            try {
                await unlink(path.resolve(uri))
            } catch (err) {
                if (err.code !== 'ENOENT') throw err
            }
        }

        async function link(source) {
            const stat = await lstat(source)
            if (stat.isSymbolicLink()) {
                return await realpath(source)
            }
        }

        onSync(collection, async ({ action, context }) => {
            if (!context.relativePath) return false
            const { relativePath } = context

            const source = path.join(runtime.options.filesFolder, relativePath)
            const format = path.extname(relativePath).substring(1).toLowerCase()
            const id = path.join(`/${collection}`, relativePath)
            let name = relativePath
            if (options.outputFolder) {
                name = path.join(options.outputFolder, relativePath)
            }
            // The SOURCE file, as in every other collection.
            //
            // It used to be the symlink in the output, which made `uri` mean
            // one thing for documents and layouts and the opposite here — and
            // three separate pieces of code carry scars from it: the render
            // file helper keys its edges on `id` with a comment explaining
            // that a uri edge "matches nothing" for files, locateEntityFile
            // rejected every file entity as living outside its own collection
            // folder, and sweepDeleted could not be called at all because it
            // scopes by uri rooted at the folder a source owns.
            //
            // Where the bytes are PUBLISHED is meta.url, which every consumer
            // already reads (ADR-0011).
            const uri = source

            let synced = true
            switch (action) {
                case ACTION.CREATE:
                    await ensureLink(relativePath)
                    await createEntity({
                        id,
                        uri,
                        name,
                        collection,
                        type,
                        format,
                        source,
                        // Deployed URL — the served path, distinct from `id`
                        // (which carries the `/files` collection prefix). A
                        // $-ref to this entity expands to it; consumers read
                        // meta.url for the served location (ADR-0011).
                        meta: { url: '/' + name },
                        checksum: await checksum(source),
                        link: await link(source)
                    })
                    break
                case ACTION.UPDATE: {
                    const current = await findEntity({ id })
                    // `checksum` is the source-checksum FUNCTION from the
                    // plugin context, not a value — it has to be called.
                    // Comparing the stored string against the function
                    // itself is never equal, which makes the guard always
                    // pass and `synced = false` unreachable.
                    const currentChecksum = await checksum(source)
                    if (current?.checksum != currentChecksum) {
                        await updateEntity({
                            id,
                            uri,
                            // `name` — the prefixed form, the same one
                            // CREATE uses. `relativePath` here drops the
                            // outputFolder prefix that meta.url two lines
                            // down keeps. The assets plugin builds preset
                            // destinations from `name`, so the two
                            // disagreeing sends a watched replacement's
                            // derivatives somewhere else than a fresh
                            // import's, and records the wrong path in
                            // meta.presets.
                            name,
                            collection,
                            type,
                            format,
                            source,
                            meta: { url: '/' + name },
                            checksum: currentChecksum,
                            link: await link(source)
                        })
                    } else {
                        synced = false
                    }
                    break
                }
                case ACTION.DELETE:
                    await removeLink(relativePath)
                    await deleteEntity({
                        id,
                        collection,
                        type,
                    })
                    break
            }
            return synced
        })

        onLoaded(async () => {
            const logger = useLogger()
            runtime.options.files = runtime.options.files ?? options.filesFolder ?? collection
            runtime.options.filesFolder = path.join(runtime.options.workingFolder, runtime.options.files)

            logger.debug('Files folder: %s', runtime.options.filesFolder)
            await mkdir(runtime.options.filesFolder, { recursive: true })

            watch(collection, runtime.options.filesFolder)
        })

        onImport(async () => {
            const logger = useLogger()
            await mkdir(runtime.options.outputFolder, { recursive: true })
            if (options.outputFolder) await mkdir(path.join(runtime.options.outputFolder, options.outputFolder), { recursive: true })

            const paths = await globby('**/*', { cwd: runtime.options.filesFolder })
            trackProgress('Files import', paths.length)
            // Bulk-prefetch the catalog's existing (id → checksum) map for
            // this collection once at scan start, so the gate below reads
            // from it per-file instead of doing per-file SQL lookups. Same
            // pattern source.js uses for documents/layouts via useSource.
            // Without this gate the plugin re-emitted createEntity on every
            // cycle for every file regardless of changes, inflating the
            // journal with phantom mutations and triggering downstream
            // re-dispatch of aggregate layouts whose recorded query deps
            // matched the collection.
            // --force (and a wiped catalog) must defeat this gate, the
            // same way source.js's gateChecksum lets them defeat its own.
            // This is a second, independent gate: if it ignores them, no
            // amount of forcing re-derives a file's name / meta.url /
            // meta.presets, and a catalog holding bad `files` rows has no
            // repair path short of deleting them.
            const forced = runtime.options.force || runtime.catalog?.cacheInvalidated
            const priorChecksums = checksumsByCollection(collection)
            const scanned = new Set()
            await pMap(paths, async relativePath => {
                const { source } = await ensureLink(relativePath)
                const uri = source
                let name = relativePath
                if (options.outputFolder) {
                    name = path.join(options.outputFolder, relativePath)
                }
                const id = path.join(`/${collection}`, relativePath)
                // Recorded before the checksum gate. The gate decides whether
                // to re-emit; the sweep asks what still EXISTS, and a file
                // skipped for being unchanged very much exists.
                scanned.add(id)
                const newChecksum = await checksum(source)
                updateProgress()
                // Gate: if the catalog already has this entity with the same
                // checksum, the file hasn't changed since the last cycle.
                // Skip emitting a CREATE — the catalog row stays correct,
                // the journal stays accurate (mutations = actual changes),
                // and downstream aggregate-layout invalidation isn't fired
                // spuriously.
                if (!forced && priorChecksums.get(id) === newChecksum) return
                await createEntity({
                    id,
                    uri,
                    collection,
                    type,
                    format: path.extname(relativePath).substring(1).toLowerCase(),
                    name,
                    source,
                    meta: { url: '/' + name },
                    checksum: newChecksum,
                    link: await link(source),
                })
            }, { concurrency: 16 })

            // What the catalog holds that the disk no longer does.
            //
            // The scan enumerates what exists and never asked the opposite
            // question, so deleting a file with nothing watching left three
            // things behind on every subsequent build: a DANGLING SYMLINK in
            // the deployed output, the catalog row, and anything derived from
            // it. Neither a plain rebuild nor --force removed them; only
            // --clear did, or a watcher that happened to be running at the
            // moment the file disappeared.
            //
            // ownerPrefix is the files folder, which is only a meaningful
            // scope now that `uri` names the source. It keeps the sweep off
            // entities another plugin emitted into this collection — a CSV, a
            // drive, an API — which is the accident the parameter exists to
            // prevent.
            //
            // Skipped under --force, like every other sweep: that guard lives
            // in sweepDeleted and is shared with documents and layouts.
            const deleted = await sweepDeleted(collection, scanned, async (entity) => {
                await removeLink(path.relative(runtime.options.filesFolder, entity.uri))
                await deleteEntity(entity)
                logger.debug('files removed (file gone): %s', entity.name)
            }, runtime.options.filesFolder)
            if (deleted) logger.info('Files removed: %d no longer on disk', deleted)
        })

        return {
            collection,
            type,
        }
    }
}
