import path from 'path'
import runtime from '../runtime.js'

// ── operating-system and file-manager litter ────────────────────────────
//
// Exposing a source folder over a network filesystem (mikser-io-drive) or
// simply opening it in a file manager drops metadata files into it. Every one
// of them would otherwise become an entity, render a page, and appear in a
// catalog.
//
// The dot-prefixed ones were already handled by accident: globby defaults to
// `dot: false` and the watcher ignores /[\/\\]\./ — so .DS_Store and ._*
// never got through. The Windows ones are NOT dotfiles, and measurably did:
// Thumbs.db and desktop.ini were both scanned AND watched. That asymmetry is
// the reason this list is explicit rather than a rule about leading dots.
//
// Deliberately conservative: OS and file-manager artifacts only. No *.tmp,
// no *.bak, no editor backups — anything a person might plausibly have meant
// to write stays out, because a filter that silently drops content is worse
// than the litter it prevents.
const JUNK_NAMES = new Set([
    '.DS_Store',                            // macOS Finder, every folder it opens
    '.localized',                           // macOS localised folder marker
    '.VolumeIcon.icns',
    '.com.apple.timemachine.donotpresent',
    'Icon\r',                               // macOS custom folder icon (trailing CR)
    'Thumbs.db',                            // Windows Explorer thumbnail cache
    'ehthumbs.db',
    'ehthumbs_vista.db',
    'desktop.ini',                          // Windows folder customisation
])

const JUNK_DIRS = new Set([
    '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
    '.DocumentRevisions-V100', '.AppleDouble', '.AppleDB', '.AppleDesktop',
    '$RECYCLE.BIN', 'System Volume Information',
])

const JUNK_PATTERNS = [
    /^\._/,              // macOS AppleDouble resource fork
    /^~\$/,              // Microsoft Office lock/owner file (~$report.docx)
    /^\.~lock\..*#$/,    // LibreOffice lock file
]

// Is this path OS/file-manager litter? Matches on the basename, and on any
// directory segment for the folder-shaped ones — litter inside .Trashes is
// still litter whatever it is called.
export function isJunkPath(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false
    const segments = filePath.split(/[/\\]/)
    const name = segments[segments.length - 1]
    if (!name) return false
    if (JUNK_NAMES.has(name)) return true
    if (JUNK_PATTERNS.some(re => re.test(name))) return true
    return segments.slice(0, -1).some(segment => JUNK_DIRS.has(segment))
}

// The same list as globby ignore patterns, for the scan side.
export const JUNK_IGNORE = [
    ...[...JUNK_NAMES].map(name => `**/${name}`),
    ...[...JUNK_DIRS].map(dir => `**/${dir}/**`),
    '**/._*',
    '**/~$*',
    '**/.~lock.*#',
]

// Plugins contribute their own artifacts.
//
// The built-in list is OS and file-manager litter, and it stays that way —
// the engine has no business knowing what a particular library's sidecar file
// is called. What it can provide is the mechanism: a plugin that writes
// metadata next to content says so, and both the scan and the watcher honour
// it. (mikser-io-drive registers `*.nephelemeta` for exactly this reason:
// the collection-level file is dot-prefixed and was already invisible, while
// the per-file one — `page.md.nephelemeta` — is not, and was measurably
// becoming an entity.)
const registered = { ignore: [], match: [] }

export function registerJunk({ ignore = [], match } = {}) {
    registered.ignore.push(...(Array.isArray(ignore) ? ignore : [ignore]))
    for (const m of (Array.isArray(match) ? match : match ? [match] : [])) {
        if (m instanceof RegExp) registered.match.push((name) => m.test(name))
        else if (typeof m === 'function') registered.match.push(m)
        else throw new Error('registerJunk: `match` must be a RegExp or a function')
    }
}

// `junk: false` in config turns the filter off entirely; an array replaces
// the built-in list. Plugin registrations survive an array override — an
// operator narrowing the OS list did not ask to start importing a library's
// sidecar files.
export function junkIgnore() {
    const configured = runtime.config?.junk
    if (configured === false) return []
    if (Array.isArray(configured)) return [...configured, ...registered.ignore]
    return [...JUNK_IGNORE, ...registered.ignore]
}

export function junkFilter() {
    const configured = runtime.config?.junk
    if (configured === false) return () => false
    if (!registered.match.length) return isJunkPath
    return (filePath) => {
        if (isJunkPath(filePath)) return true
        if (typeof filePath !== 'string') return false
        const name = filePath.split(/[/\\]/).pop()
        return registered.match.some(test => test(name))
    }
}
