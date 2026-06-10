// Same as test/perf/mikser.config.js but the engine database is
// in-memory. Apples-to-apples comparison vs the pre-Phase-7 Map+NDJSON
// numbers — both keep state in memory across the cycle, neither pays
// disk-write cost.

export default async () => ({
    plugins: [
        'documents',
        'front-matter',
        'yaml',
        'layouts',
        'render-hbs',
    ],
    database: {
        filename: ':memory:',
    },
    documents: {
        documentsFolder: 'documents',
    },
    layouts: {
        autoLayouts: true,
    },
})
