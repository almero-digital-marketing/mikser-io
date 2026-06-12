import { useSource } from '../source.js'

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
