import { mkdir, symlink, stat } from 'node:fs/promises'
import path from 'node:path'

export default ({
    useLogger,
    onLoaded,
    runtime
}) => {
    onLoaded(async () => {
        const logger = useLogger()

        for (let item of (runtime.config.shares?.locations || [])) {
            let source, destination
            if (typeof item == 'string') {
                source = destination = item
            } else {
                source = item.source
                destination = item.destination
            }

            let destinationLocation = path.join(runtime.options.outputFolder, destination)
            let destinationFolder = path.dirname(destinationLocation)
            try {
                const sourceLocation = path.join(runtime.options.workingFolder, source)
                const sourceStat = await stat(sourceLocation)

                await mkdir(destinationFolder, { recursive: true })
                logger.debug('Sharing: %s → %s', sourceLocation, destinationLocation)
                if (sourceStat.isDirectory()) {
                    await symlink(path.resolve(sourceLocation), destinationLocation, 'dir')
                } else {
                    await symlink(path.resolve(sourceLocation), destinationLocation, 'file')
                }
            } catch (err) {
                if (err.code != 'EEXIST')
                    throw err
            }
        }
    })
}