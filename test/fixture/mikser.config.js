import { fileURLToPath } from 'node:url'
import {
    documents, frontMatter, yaml, files, resources, assets,
    renderHbs, hrefUrlHelpers, assetUrlHelper, resourceUrlHelper,
} from 'mikser-io'
import { layouts }        from 'mikser-io-layouts'
import { renderLiquid }   from 'mikser-io-render-liquid'
import { renderEta }      from 'mikser-io-render-eta'
import { renderMarkdown } from 'mikser-io-render-markdown'
import { postPdf }        from 'mikser-io-post-pdf'
import { postMjml }       from 'mikser-io-post-mjml'
import { vector }         from 'mikser-io-vector'
import { openai }         from '@ai-sdk/openai'
import { decap }          from 'mikser-io-decap'
import { schemas }        from 'mikser-io-schemas'

try {
    process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)))
} catch {}

export default async ({ options }) => ({
    // Deliberately NO siteRoots. This fixture is ONE site with language
    // folders — out/bg and out/en share a root, which is what its language
    // switcher (`../en/index.html`) and its shared out/styles both rely on.
    // Declaring siteRoots here would claim each language is deployed as its
    // own domain, and the reference check correctly reports twelve broken urls
    // when it is: the claim would be the bug, not the finding.
    //
    // The multi-domain shape has its own scenario — see
    // test/scenarios/deployment-shape.test.js — where shares() puts the assets
    // under each root and nothing links across them, which is what a real
    // per-domain deployment does.
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
        hrefUrlHelpers(),
        resourceUrlHelper(),
        assetUrlHelper(),
        postPdf(),
        postMjml(),
        vector({
            model: openai.embedding('text-embedding-3-small'),
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
