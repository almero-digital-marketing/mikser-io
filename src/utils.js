import { hashFile, hash } from 'hasha'
import { stat } from 'node:fs/promises'
import TruncateStream from 'truncate-stream'
import { createReadStream } from 'node:fs'
import _ from 'lodash'
import { minimatch } from 'minimatch'
import path from 'path'

export class AbortError extends Error {
    constructor(message) {
        super();
        this.name = 'AbortError';
        this.message = message;
    }
}

export async function checksum(uri) {
    const maxBytes = 300 * 1024
    const { size } = await stat(uri)
    if (size < maxBytes) {
        return await hashFile(uri, { algorithm: 'md5' })
    } else {
        const truncate = new TruncateStream({ maxBytes })
        const fileStream = createReadStream(uri)
        fileStream.pipe(truncate)
        const checksum = size.toString() + ':' + await hash(truncate, { algorithm: 'md5' })
        return checksum
    }
}

export function normalize(object) {
    return _.pickBy(
        object,
        (value, key) => {
            let pick = value !== undefined &&
                value !== '' &&
                value !== null &&
                key !== 'undefined' &&
                key !== '' &&
                key !== 'null' &&
                (typeof (value) != 'number' || !isNaN(value))
            return pick
        }
    )
}

export function matchEntity(entity, match) {
    if (!match) return false
    if (typeof match == 'function') return match(entity)
    else if (typeof match == 'string') {
        if (match.substring(0, 2) == '@/') {
            return minimatch(typeof entity == 'string' ? entity : entity.name, match.substring(2))
        } else {
            return minimatch(typeof entity == 'string' ? entity : entity.id, match)
        }
    }
    else if (typeof match == 'object') return _.isMatch(entity, match)
    throw new Error('Ivalid match type')
}

export function changeExtension(file, format) {
    let extension = path.extname(file)
    let result = file.substring(0, file.length - extension.length) + '.' + format
    return result
}

// Decode a layout filename into its parts. `template` is the outer
// extension (the renderer); `format` is the output format encoded as a
// second extension (defaults to 'html'); `postprocessor`, if present,
// is everything after the `-` in the format segment.
//
// Examples:
//   foo.hbs                 -> { name:'foo',  format:'html', template:'hbs',  postprocessor:undefined }
//   page.css.hbs            -> { name:'page', format:'css',  template:'hbs',  postprocessor:undefined }
//   report.html-pdf.hbs     -> { name:'report', format:'html', template:'hbs', postprocessor:'pdf' }
//   welcome.html-mjml.liquid-> { name:'welcome', format:'html', template:'liquid', postprocessor:'mjml' }
export function getFormatInfo(relativePath) {
    const template = path.extname(relativePath).substring(1).toLowerCase()
    const withoutTemplate = relativePath.replace(path.extname(relativePath), '')
    const formatExt = path.extname(withoutTemplate).substring(1).toLowerCase()
    const [format, postprocessor] = formatExt.split('-')
    const name = formatExt ? withoutTemplate.replace(path.extname(withoutTemplate), '') : withoutTemplate
    return { name, format: format || 'html', template, postprocessor }
}

// Flatten template-helper args into a single human-readable message.
// Handlebars helpers receive a trailing options object (it has a `.hash`
// property) which we drop. Liquid filters and Eta calls don't.
export function formatLogArgs(args) {
    if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null && 'hash' in args[args.length - 1]) {
        args = args.slice(0, -1)
    }
    return args
        .map(arg => {
            if (arg == null) return String(arg)
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg) } catch { return String(arg) }
            }
            return String(arg)
        })
        .join(' ')
}

// Build a compact "[layouts/foo.hbs:12:4]" suffix from whatever the
// underlying template engine attached to its thrown error. Renderer
// plugins are expected to set `err.layoutUri` (and optionally `err.line` /
// `err.column`) before rethrowing.
export function formatErrorContext(entity, err, options) {
    const layoutUri = err?.layoutUri || entity?.layout?.uri || entity?.layout?.id
    if (!layoutUri) return ''
    const workingFolder = options?.workingFolder
    const rel = workingFolder && layoutUri.startsWith(workingFolder + '/')
        ? layoutUri.slice(workingFolder.length + 1)
        : layoutUri
    const line = err?.line ?? err?.lineNumber
    const column = err?.column ?? err?.col
    let pos = ''
    if (line) pos = `:${line}${column ? ':' + column : ''}`
    return ` [${rel}${pos}]`
}