import path from 'node:path'
import { cliOption } from '../cli.js'
import { existsSync } from 'node:fs'
import { mkdir, symlink, lstat, readlink, realpath } from 'fs/promises'
import { globby } from 'globby'
import pMap from 'p-map'
import { checksumsByCollection } from '../catalog.js'
import { isFullCycle } from '../invalidation.js'
import { gateChecksum, sweepDeleted } from '../source.js'
import { removeOutput } from '../utils/index.js'

// Links in the output that the files folder no longer backs.
//
// `sweepDeleted` asks the CATALOG what disappeared, and a wipe leaves it
// nothing to answer from: a config change unlinks the cache, and a file
// deleted in the same delivery has no row left to be missing from, so its
// symlink stays in the output and no later build removes it. Whatever walks
// that output with `stat` then crashes on a link to nothing — a deploy
// script's own scope check, twice.
//
// So this asks the DISK, and only about links this plugin could have made: a
// symlink whose target is inside the files folder. A dangling one of those is
// ours and is garbage whatever the catalog holds. A rendered page, the assets
// tree's own symlink, a file another tool wrote — not examined, not removed.
//
// Through `removeOutput`, so a link takes the folders it empties with it:
// `media/assets/fonts/x.woff2` left its own folder chain behind for a static
// host to answer with a listing.
export async function removeStaleLinks({ outputFolder, linkRoot, filesFolder, logger }) {
    if (!existsSync(linkRoot)) return 0
    const owned = path.resolve(filesFolder)
    // objectMode for the dirent: with `followSymbolicLinks: false` it already
    // says which entries are links, so only those are read — a walk that
    // lstat'd every file would cost the whole output tree.
    const entries = await globby('**/*', {
        cwd: linkRoot,
        onlyFiles: false,
        followSymbolicLinks: false,
        objectMode: true,
        dot: true,
    })
    let removed = 0
    for (const entry of entries) {
        if (!entry.dirent.isSymbolicLink()) continue
        const uri = path.join(linkRoot, entry.path)
        let target
        try {
            target = path.resolve(path.dirname(uri), await readlink(uri))
        } catch { continue }
        if (target !== owned && !target.startsWith(owned + path.sep)) continue
        if (existsSync(target)) continue
        await removeOutput(outputFolder, path.relative(outputFolder, uri))
        logger?.debug('files link removed (source gone): %s', entry.path)
        removed++
    }
    return removed
}

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
            // Through removeOutput, which takes the folders the link empties
            // with it and treats a file already gone as the success it is.
            await removeOutput(runtime.options.outputFolder,
                path.relative(runtime.options.outputFolder, path.resolve(uri)))
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
                case ACTION.CREATE: {
                    // The checksum FIRST, and the link only once it answered.
                    //
                    // Linking first left a symlink pointing at nothing when
                    // the source moved between the event and the read: the
                    // link was made, `checksum` threw ENOENT, the entity was
                    // never created, and out/ kept a dangling link that no
                    // catalog row admits to. It then broke whatever walked
                    // the output with stat — a consumer's own scope check,
                    // twice.
                    //
                    // Reading first makes the vanishing case leave nothing
                    // behind: the throw happens before anything is written,
                    // and the watcher logs it as the ordinary event it is.
                    const sourceChecksum = await checksum(source)
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
                        checksum: sourceChecksum,
                        link: await link(source)
                    })
                    break
                }
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

            // A longer settle than the engine's default, because this is the
            // collection large binaries land in and they are the case that
            // bit: a video uploaded over WebDAV grows for as long as the link
            // takes, and an event fired mid-upload gets a checksum of a
            // partial file — once, of a file read at zero bytes, which was
            // then published as current.
            //
            // Three seconds of stability costs nothing here (nobody edits a
            // 300 MB video and waits for the page) and buys the margin a slow
            // or stalling link needs.
            watch(collection, runtime.options.filesFolder, {
                awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 200 },
            })
        })

        onImport(async () => {
            const logger = useLogger()
            await mkdir(runtime.options.outputFolder, { recursive: true })
            if (options.outputFolder) await mkdir(path.join(runtime.options.outputFolder, options.outputFolder), { recursive: true })

            const paths = await globby('**/*', { cwd: runtime.options.filesFolder })
            trackProgress('Files import', paths.length)
            // The SHARED gate, not a copy of it.
            //
            // Without a gate the plugin re-emitted createEntity on every cycle
            // for every file regardless of changes, inflating the journal with
            // phantom mutations and triggering downstream re-dispatch of
            // aggregate layouts whose recorded query deps matched the
            // collection. So it grew one — and then it was a SECOND,
            // independent implementation of the decision source.js already
            // owns, which is how it silently missed the missing-output bypass
            // that was added to the original: an image derivative deleted from
            // the assets folder was never regenerated, because the file it
            // derives from was gated here as unchanged and never reached the
            // assets plugin. Green build, missing image, and only
            // --audit-output said otherwise.
            //
            // Every reason to defeat the gate — --force, a wiped catalog, a
            // recorded output that is gone — now lives in exactly one place,
            // so the next one cannot be added to that place and missed here.
            //
            // priorChecksums is still bulk-prefetched per scan so the gate
            // reads a map instead of doing per-file SQL. What overrides the
            // checksum, the gate asks invalidation.js for itself.
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
                // Returns the checksum to stamp on the entity, or null when
                // the catalog already has this file unchanged and there is
                // nothing to emit. Progress ticks either way — a gated file
                // was still looked at.
                const newChecksum = await gateChecksum(source, id, { priorChecksums })
                updateProgress(id)
                if (newChecksum === null) return
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
            // Runs under --force too, like every other sweep: that decision
            // lives in sweepDeleted and is shared with documents and layouts.
            // Nothing about --force wipes the catalog, so a row for a file
            // that no longer exists would otherwise survive the one flag
            // reached for exactly that.
            const deleted = await sweepDeleted(collection, scanned, async (entity) => {
                await removeLink(path.relative(runtime.options.filesFolder, entity.uri))
                await deleteEntity(entity)
                logger.debug('files removed (file gone): %s', entity.name)
            }, runtime.options.filesFolder)
            if (deleted) logger.info('Files removed: %d no longer on disk', deleted)

            // The same question asked of the DISK, on the cycles where the
            // catalog cannot answer it.
            //
            // A wipe is the case that matters: the cache is unlinked and
            // reopened empty, which is also what makes this a full cycle — a
            // config change stamps `firstRun` through `upgradedFromVersion`,
            // not through the file being absent — so a file deleted in the
            // same delivery leaves no row for the sweep above to miss. Under
            // --force that sweep is complete, and this still reaches what no
            // row ever described: a link whose entity never got written.
            //
            // An incremental cycle pays nothing for it. The walk is the whole
            // output tree, and the sweep it complements is already right there.
            if (isFullCycle(runtime)) {
                const stale = await removeStaleLinks({
                    outputFolder: runtime.options.outputFolder,
                    linkRoot: options.outputFolder
                        ? path.join(runtime.options.outputFolder, options.outputFolder)
                        : runtime.options.outputFolder,
                    filesFolder: runtime.options.filesFolder,
                    logger,
                })
                if (stale) logger.info('Files links removed: %d pointing at nothing', stale)
            }
        })

        return {
            collection,
            type,
            module: import.meta.url,
        }
    }
}
