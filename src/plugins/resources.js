import { mkdir, symlink, rename, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import lodash from 'lodash'
import deepdash from 'deepdash'
import axios from 'axios'
import path from 'node:path'
import { globby } from 'globby'
import escapeStringRegexp from 'escape-string-regexp'
import * as stream from 'stream'
import { promisify } from 'util'
import isUrl from 'is-url'
import map from 'p-map'
import { matchesLibrary } from '../utils.js'

export function resources(options = {}) {
    return ({
        useLogger,
        useJournal,
        onLoaded,
        runtime,
        stopProgress,
        createEntity,
        onProcessed,
        onFinalize,
        checksum,
        trackProgress,
        updateProgress,
        constants: { OPERATION },
    }) => {
    const collection = 'resources'
    const type = 'resource'

    const _ = deepdash(lodash)

    const finishedDownload = promisify(stream.finished)

    onLoaded(async () => {
        const logger = useLogger()

        const resourcesName = options.resourcesFolder || collection
        runtime.state.resources = {
            resourceLib: {},
            resourceMap: {},
            resourcesFolder: options.outputFolder
                ? path.join(options.outputFolder, resourcesName)
                : resourcesName,
        }

        runtime.options.resources = options.resourcesFolder || collection
        runtime.options.resourcesFolder = path.join(runtime.options.workingFolder, runtime.options.resources)
        logger.debug('Resources folder: %s', runtime.options.resourcesFolder)

        for (let library in (options.libraries || [])) {
            let resource = options.libraries[library]
                // The key is a REGULAR EXPRESSION source, which is what the
            // escapeStringRegexp call says: you only escape a string you are
            // about to compile. The render helper has always read it that way
            // (`url.match(library)`), so a library declared by `url` is a
            // prefix pattern matching anything under it.
            runtime.state.resources.resourceLib[resource.match || escapeStringRegexp(resource.url)] = library
        }
    })

    onProcessed(async (signal) => {
        const logger = useLogger()
        const { resourceLib, resourceMap } = runtime.state.resources

        for await (let { entity } of useJournal('Resources provision', [OPERATION.CREATE, OPERATION.UPDATE], signal)) {
            if (entity.collection != collection && entity.meta) {
                resourceMap[entity.id] = []
                _.eachDeep(entity.meta, resource => {
                    if (typeof resource == 'string') {
                        for (let library in resourceLib) {
                            // Regex, matching the render helper. This used
                            // matchEntity, which is a GLOB demanding a full
                            // match — so a key derived from `url` (a bare
                            // prefix, no trailing wildcard) matched nothing and
                            // NO url-declared library was ever downloaded. The
                            // helper still built urls for them, so pages linked
                            // files nothing fetched and the build stayed green:
                            // one string read with two incompatible matchers.
                            if (matchesLibrary(resource, library)) {
                                resourceMap[entity.id].push({ library, resource, entity })
                            }
                        }
                    }
                })
                entity.resources = resourceMap[entity.id].map(({ resource }) => resource)
            }
        }
        const resources = [].concat(...Object.values(resourceMap))
        resources.length && logger.info('Resources: %d', resources.length)

        const resourceDownloads = {}
        const localResources = new Set()
        trackProgress('Resources processing', resources.length)
        for (let { library, resource, entity } of resources) {
            if (signal?.aborted) {
                stopProgress()
                break
            }

            library = resourceLib[library]
            if (isUrl(resource)) {
                if (!resourceDownloads[resource]) {
                    resourceDownloads[resource] = { library, entity }
                }
            } else {
                try {
                    const id = resource.indexOf(`/${library}`) == 0 ? resource : path.join(`/${library}`, resource)
                    if (!localResources.has(id)) {
                        const resourceName = resource.indexOf('/') == 0 ? resource.substring(1) : resource
                        await createEntity({
                            id,
                            uri: path.join(runtime.options.workingFolder, resource),
                            collection,
                            type,
                            format: path.extname(resource).substring(1).toLowerCase(),
                            name: resourceName,
                            // Served path — a $-ref to this entity expands to it;
                            // consumers read meta.url for the location (ADR-0011).
                            meta: { url: '/' + resourceName },
                            source: path.join(runtime.options.workingFolder, resource),
                            checksum: await checksum(path.join(runtime.options.workingFolder, resource))
                        })
                        logger.debug('Resource: %s %s', id, resource)
                        localResources.add(id)
                    }
                } catch (err) {
                    logger.error('Resource error: %s %s %s', entity.id, resource, err.message)
                }
            }
            updateProgress()
        }

        const resourceFiles = await globby('**/*', { cwd: runtime.options.resourcesFolder })
        const resourceFilesMap = new Set()
        for (let resourceFile of resourceFiles) {
            resourceFilesMap.add(resourceFile)
        }

        const downloads = Object.keys(resourceDownloads)
        if (downloads.length) {
            trackProgress('Resources download', downloads.length)
            await mkdir(runtime.options.resourcesFolder, { recursive: true })
            let link = path.join(runtime.options.outputFolder, runtime.options.resources)
            if (options.outputFolder) link = path.join(runtime.options.outputFolder, options.outputFolder, runtime.options.resources)
            try {
                await mkdir(path.dirname(link), { recursive: true })
                await symlink(path.resolve(runtime.options.resourcesFolder), link, 'dir')
            } catch (err) {
                if (err.code != 'EEXIST')
                    throw err
            }
            let count = 0
            await map(downloads, async url => {
                const { library, entity } = resourceDownloads[url]
                let { pathname } = new URL(url)
                pathname = decodeURI(pathname)
                const resource = path.join(runtime.options.resourcesFolder, library, pathname)
                const uri = path.join(runtime.options.outputFolder, library, pathname)

                let success = true
                if (!resourceFilesMap.has(path.join(library, pathname))) {
                    const resourceTemp = path.join(runtime.options.resourcesFolder, library, pathname + '.temp')
                    logger.debug('Downloading resource: %s %s', entity.id, url)
                    const config = options.libraries[library]
                    const request = {
                        method: 'get',
                        ...config,
                        url,
                        responseType: 'stream',
                        signal
                    }

                    try {
                        count++
                        var response = await axios(request)
                    } catch (err) {
                        success == false
                        if (axios.isCancel(err)) {
                            logger.trace('Downloading canceled')
                        } else {
                            logger.error('Resource error: %s %s %s', entity.id, url, err.message)
                        }
                        return
                    }

                    if (response && success) {
                        await mkdir(path.dirname(resource), { recursive: true })
                        const writer = createWriteStream(resourceTemp)
                        response.data.pipe(writer)
                        await finishedDownload(writer)

                        logger.debug('Resource: %s %s', entity.id, url)
                        await rename(resourceTemp, resource)
                    }
                }

                if (success) {
                    const resourceName = path.join(library, pathname)
                    await createEntity({
                        id: path.join('/resources', library, pathname),
                        uri,
                        collection,
                        type,
                        format: path.extname(resource).substring(1).toLowerCase(),
                        name: resourceName,
                        meta: { url: '/' + resourceName },
                        source: resource,
                        checksum: await checksum(resource)
                    })
                }
                updateProgress()
            }, { concurrency: 10, signal })
            count && logger.info('Downloaded: %d', count)
        }
    })

    onFinalize(async () => {
        runtime.state.resources.resourceMap = {}

        const paths = await globby('**/*.temp', { cwd: runtime.options.resourcesFolder })
        for (let relativePath of paths) {
            let resourceTemp = path.join(runtime.options.resourcesFolder, relativePath)
            await unlink(resourceTemp)
        }
    })

        return {
            collection,
            type,
        }
    }
}