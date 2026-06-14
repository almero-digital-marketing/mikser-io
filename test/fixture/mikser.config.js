import { fileURLToPath } from 'node:url'
import {
    documents, frontMatter, yaml, files, resources, assets,
    renderHbs, renderHref, renderAsset, renderResource,
} from 'mikser-io'
import { layouts }        from 'mikser-io-layouts'
import { renderLiquid }   from 'mikser-io-render-liquid'
import { renderEta }      from 'mikser-io-render-eta'
import { renderMarkdown } from 'mikser-io-render-markdown'
import { postPdf }        from 'mikser-io-post-pdf'
import { postMjml }       from 'mikser-io-post-mjml'
import { vector }         from 'mikser-io-vector'
import { decap }          from 'mikser-io-decap'
import { schemas }        from 'mikser-io-schemas'

try {
    process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)))
} catch {}

export default async ({ options }) => ({
    plugins: [
        documents(),
        frontMatter(),
        yaml(),
        layouts({ autoLayouts: true }),
        files(),
        resources({
            outputFolder: 'public',
            libraries: {
                images: { url: 'https://placehold.co/' },
                videos: { url: 'https://lorem.video/' },
            },
        }),
        assets({
            outputFolder: 'public',
            presets: {
                'small-image': [
                    '/files/images/*.jpg',
                    '/resources/**/*.jpg',
                ],
                'small-video': [
                    '/files/videos/*.mp4',
                    '/resources/**/*.mp4',
                ],
            },
        }),
        renderHbs(),
        renderLiquid(),
        renderEta(),
        renderMarkdown(),
        renderHref(),
        renderResource(),
        renderAsset(),
        postPdf(),
        postMjml(),
        vector({
            openai: { apiKey: process.env.OPENAI_API_KEY },
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
        }),
        decap(),
        schemas(),
    ],
})
