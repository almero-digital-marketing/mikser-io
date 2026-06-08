import ffmpeg from 'fluent-ffmpeg'

export const revision = 2
export const options = {
    tasks: 'serial',
}

export default ({ entity: { name, source, destination, preset }, logger }) => {
    return new Promise((resolve, reject) => {
        ffmpeg(source)
            .noAudio()
            .videoCodec('libx264')
            .size('320x180')
            .videoBitrate(300)
            .fps(20)
            .on('progress', ({ percent }) => logger.trace(`Progress: [${preset.name}] ${name} ${Math.round(percent)}%`))
            .on('error', reject)
            .on('end', resolve)
            .save(destination)
    })
}