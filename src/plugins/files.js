import path from 'node:path'
import { mkdir, symlink, unlink, lstat, realpath } from 'fs/promises'
import { globby } from 'globby'

export default ({
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
        if (runtime.config.files?.outputFolder) uri = path.join(runtime.options.outputFolder, runtime.config.files.outputFolder, relativePath)
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
        if (runtime.config.files?.outputFolder) uri = path.join(runtime.options.outputFolder, runtime.config.files.outputFolder, relativePath)
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
        if (runtime.config.files?.outputFolder) {
            uri = path.join(runtime.options.outputFolder, runtime.config.files.outputFolder, relativePath)
            name = path.join(runtime.config.files.outputFolder, relativePath)
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
        runtime.options.files = runtime.config.files?.filesFolder || collection
        runtime.options.filesFolder = path.join(runtime.options.workingFolder, runtime.options.files)

        logger.debug('Files folder: %s', runtime.options.filesFolder)
        await mkdir(runtime.options.filesFolder, { recursive: true })

        watch(collection, runtime.options.filesFolder)
    })

    onImport(async () => {
        await mkdir(runtime.options.outputFolder, { recursive: true })
        if (runtime.config.files?.outputFolder) await mkdir(path.join(runtime.options.outputFolder, runtime.config.files.outputFolder), { recursive: true })

        const paths = await globby('**/*', { cwd: runtime.options.filesFolder })
        trackProgress('Files import', paths.length)
        return Promise.all(paths.map(async relativePath => {
            const { uri, source } = await ensureLink(relativePath)
            let name = relativePath
            if (runtime.config.files?.outputFolder) {
                name = path.join(runtime.config.files.outputFolder, relativePath)
            }
            await createEntity({
                id: path.join(`/${collection}`, relativePath),
                uri,
                collection,
                type,
                format: path.extname(relativePath).substring(1).toLowerCase(),
                name,
                source,
                checksum: await checksum(source),
                link: await link(source)
            })
            updateProgress()
        }))
    })

    return {
        collection,
        type
    }
}
