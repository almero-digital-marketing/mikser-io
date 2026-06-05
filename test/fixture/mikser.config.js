import { fileURLToPath } from 'node:url'

try {
    process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)))
} catch {}

export default async ({ options }) => ({
	plugins: [
		'documents',
		'front-matter',
		'yaml',
		'layouts',
		'files',
        'resources',
		'assets',
		'render-hbs',
		'render-liquid',
		'render-eta',
		'render-href',
		'render-resource',
		'render-asset',
		'render-markdown',
		'post-pdf',
		'post-mjml',
		'vector',
		'decap',
		// plugin-schemas — exercises ADR-0007 A6 deferred ref validation.
		// `schemaKey` intentionally unset because we are not validating
		// schema shape here, only the engine-level $-key references.
		// The plugin still runs its ref-existence checks regardless of
		// `schemaKey` and surfaces warnings via the pending list.
		'plugin-schemas',
		// Note: reverse-reference index now lives in the engine
		// (runtime.refs.*). No 'plugin-refs' needed — see ADR-0007 §B9
		// for the lift-to-engine rationale.
	],
    vector: {
        // Flip to pg automatically when PGHOST is set; otherwise sqlite.
        // For pg, omit `connection` — pg reads libpq env vars (PGHOST,
        // PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE...).
        client: process.env.PGHOST ? 'pg' : 'better-sqlite3',
        openai: {
            apiKey: process.env.OPENAI_API_KEY,
        },
        stores: {
            documents: {
                map: entity => ({
                    title: entity.meta?.title,
                    lang: entity.meta?.lang,
                    layout: entity.meta?.layout,
                    content: entity.content,
                }),
            },
        },
    },
    resources: {
        outputFolder: 'public',
		libraries: {
			images: {
				url: 'https://placehold.co/',
			},
            videos: {
                url: 'https://lorem.video/'
            }
		}
	},
    assets: {
        outputFolder: 'public',
        presets: {
            'small-image': [
                '/files/images/*.jpg', 
                '/resources/**/*.jpg', 
            ],
            'small-video': [
                '/files/videos/*.mp4', 
                '/resources/**/*.mp4', 
            ]
        }
    },
    layouts: {
        autoLayouts: true,
    }
})
