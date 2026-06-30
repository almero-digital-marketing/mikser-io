import path from 'node:path'
import { mkdir, symlink, unlink, lstat, realpath } from 'fs/promises'
import { globby } from 'globby'
import pMap from 'p-map'
import { checksumsByCollection } from '../catalog.js'

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

        async function removeLink(relativePath) {
            let uri = path.join(runtime.options.outputFolder, relativePath)
            if (options.outputFolder) uri = path.join(runtime.options.outputFolder, options.outputFolder, relativePath)
            await unlink(path.resolve(uri))
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
            let uri = path.join(runtime.options.outputFolder, relativePath)
            let name = relativePath
            if (options.outputFolder) {
                uri = path.join(runtime.options.outputFolder, options.outputFolder, relativePath)
                name = path.join(options.outputFolder, relativePath)
            }

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
                case ACTION.UPDATE:
                    const current = await findEntity({ id })
                    if (current?.checksum != checksum) {
                        await updateEntity({
                            id,
                            uri,
                            name: relativePath,
                            collection,
                            type,
                            format,
                            source,
                            meta: { url: '/' + name },
                            checksum: await checksum(source),
                            link: await link(source)
                        })
                    } else {
                        synced = false
                    }
                    break
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
            runtime.options.files = options.filesFolder || collection
            runtime.options.filesFolder = path.join(runtime.options.workingFolder, runtime.options.files)

            logger.debug('Files folder: %s', runtime.options.filesFolder)
            await mkdir(runtime.options.filesFolder, { recursive: true })

            watch(collection, runtime.options.filesFolder)
        })

        onImport(async () => {
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
            const priorChecksums = checksumsByCollection(collection)
            await pMap(paths, async relativePath => {
                const { uri, source } = await ensureLink(relativePath)
                let name = relativePath
                if (options.outputFolder) {
                    name = path.join(options.outputFolder, relativePath)
                }
                const id = path.join(`/${collection}`, relativePath)
                const newChecksum = await checksum(source)
                updateProgress()
                // Gate: if the catalog already has this entity with the same
                // checksum, the file hasn't changed since the last cycle.
                // Skip emitting a CREATE — the catalog row stays correct,
                // the journal stays accurate (mutations = actual changes),
                // and downstream aggregate-layout invalidation isn't fired
                // spuriously.
                if (priorChecksums.get(id) === newChecksum) return
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
        })

        return {
            collection,
            type,
        }
    }
}
