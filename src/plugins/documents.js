import { useSource } from '../source.js'
import { cliOption } from '../cli.js'

// documents — the canonical content source plugin.
//
// Scans the documents folder, reads each file's content, and registers
// it as an entity (type: 'document'). Hot-reloads on file change.
//
// Implementation moved to useSource — what's left here is the
// plugin-specific declaration: collection name, folder config, file
// content reading, import-phase scanning.
export function documents(options = {}) {
    return (core) => {
        const collection = 'documents'
        const type = 'document'

        // The folder this plugin owns, on the command line. Config-only until
        // 9.100.0, because a plugin could not declare an option — and editing
        // the config to try another folder once invalidates the catalog,
        // whose checksum covers it. CLI beats config beats default.
        cliOption('--documents <folder>',
            'folder of source documents, relative to the working folder (default: documents)')

        useSource(core, {
            collection,
            type,
            folder: options.documentsFolder ?? collection,
            content: true,
            phase: 'import',
        })

        return { collection, type }
    }
}
