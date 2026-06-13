# Plugins

Plugins are the primary way to extend Mikser. Every content source, transformation, and output format is implemented as a plugin.

## Loading Plugins

Plugins are imported by name and called as factories. Each entry in `plugins: []` is a factory-return value — the v9 plugin loader dispatches based on the return's shape (ADR-0010). There's no string-based resolution and no `--plugins` CLI flag.

```js
import { documents, layouts, data } from 'mikser-io'
import { myCustomPlugin } from 'mikser-io-my-custom-plugin'

export default {
  plugins: [
    documents(),
    layouts({ autoLayouts: true }),
    data(),
    myCustomPlugin({ /* options */ }),
  ],
}
```

### Plugin Resolution

Plugins are standard ESM imports. There's no name-based search path — whatever Node's import resolution finds for `'mikser-io-<name>'` (or whichever package you import from) is what gets loaded.

- Built-in plugins re-export from `mikser-io`'s root: `import { documents, layouts, ... } from 'mikser-io'`.
- Sibling plugins each export a named factory: `import { vector } from 'mikser-io-vector'`.
- Project-local plugins live anywhere — drop the file, import by relative path: `import myPlugin from './plugins/my-plugin.js'`.

Renderer and postprocessor packages **are** listed in `plugins: []` alongside lifecycle plugins. They return descriptors (`{ name, options, load?, render? }` or `{ name, options, postprocess, ... }`) instead of `(core) => void` closures; the loader stores them in `runtime.renderers` / `runtime.postprocessors` and the dispatcher picks them up by name when a layout requests them.

---

## Writing a Custom Plugin

A plugin package exports a **named factory** in camelCase that matches the export name. The factory takes options and returns one of three shapes:

- **Lifecycle plugin** — returns `(core) => void`. Receives the full Mikser API and registers hooks.
- **Renderer** — returns `{ name, options, load?, render? }`.
- **Postprocessor** — returns `{ name, options, output?, setup?, postprocess, teardown? }`.

### Lifecycle plugin shape

```js
// my-custom-plugin/index.js
export function myCustomPlugin(options = {}) {
  return ({
    runtime,
    onLoaded,
    onImport,
    onProcess,
    onFinalized,
    createEntity,
    updateEntity,
    deleteEntity,
    useJournal,
    findEntity,
    findEntities,
    useLogger,
    watch,
    schedule,
    checksum,
    normalize,
    matchEntity,
    changeExtension,
    trackProgress,
    updateProgress,
    stopProgress,
    constants: { OPERATION, ACTION },
  }) => {
    const collection = 'posts'
    const type = 'post'

    onLoaded(async () => {
      const logger = useLogger()
      logger.info('My plugin loaded — folder=%s', options.folder ?? collection)
    })

    onImport(async () => {
      await createEntity({
        id: '/posts/hello',
        collection,
        type,
        format: 'md',
        name: 'hello',
        meta: { title: 'Hello World' },
      })
    })

    return { collection, type }
  }
}
```

`options` is whatever the consumer passed at the factory call site (`myCustomPlugin({ folder: 'blog' })`). The plugin reads it directly — there is **no** `runtime.config.<plugin>` channel under v9.

### Plugin Factory API

The factory function receives the complete Mikser API as a single destructured object:

| Property | Type | Description |
|----------|------|-------------|
| `runtime` | object | The runtime singleton (see [Architecture](./architecture.md)) |
| `onInitialize` | function | Register initialize hook |
| `onInitialized` | function | Register initialized hook |
| `onLoad` | function | Register load hook |
| `onLoaded` | function | Register loaded hook |
| `onImport` | function | Register import hook |
| `onImported` | function | Register imported hook |
| `onProcess` | function | Register process hook |
| `onProcessed` | function | Register processed hook |
| `onPersist` | function | Register persist hook |
| `onPersisted` | function | Register persisted hook |
| `onBeforeRender` | function | Register before-render hook |
| `onRender` | function | Register render hook |
| `onAfterRender` | function | Register after-render hook |
| `onFinalize` | function | Register finalize hook |
| `onFinalized` | function | Register finalized hook |
| `onCancel` | function | Register cancel hook |
| `onCancelled` | function | Register cancelled hook |
| `onSync` | function | Register sync hook |
| `onValidate` | function | Register validation hook |
| `onComplete` | function | Register completion hook |
| `createEntity` | function | Add a CREATE journal entry |
| `updateEntity` | function | Add an UPDATE journal entry |
| `deleteEntity` | function | Add a DELETE journal entry |
| `renderEntity` | function | Add a RENDER journal entry |
| `renderEntities` | function | Add multiple RENDER journal entries |
| `useJournal` | async generator | Iterate journal entries. Mutations to the yielded `entity` are auto-persisted (diff-detected after each yield) — no explicit `updateEntry` call required. |
| `findEntity` | function | Find one entity from catalog |
| `findEntities` | function | Find multiple entities from catalog (returns an array — materializes the full result set) |
| `iterateEntities` | async generator | Stream entities from catalog (same query shape as `findEntities`, pages CHUNK_SIZE rows at a time). Use for corpus-scale walks where the caller processes one entity at a time. |
| `addEntry` | function | Low-level journal insert |
| `updateEntry` | function | Low-level journal update. Not needed for entity mutations inside a `useJournal` walk (the auto-persist handles those); useful for engine-internal writes (`output`, `deps`) and explicit re-writes from outside a walk. |
| `registerSchema` | function | Register a sqlite schema for plugin-owned tables. Call at module-eval (or `onInitialize` if you hit a circular import). Convention: prefix tables with `<plugin>_` (e.g., `vector_<store>`). |
| `useDatabase` | function | Return the shared sqlite handle. Available from `onLoaded` onward — the engine opens the database before user plugins load. |
| `useLogger` | function | Get the pino logger instance |
| `watch` | function | Watch a folder for file changes |
| `schedule` | function | Schedule a recurring task |
| `checksum` | function | Compute MD5 checksum of a file |
| `normalize` | function | Remove null/undefined fields from object |
| `matchEntity` | function | Test if an entity matches a pattern |
| `changeExtension` | function | Change a file's extension |
| `trackProgress` | function | Start a progress bar |
| `updateProgress` | function | Increment progress |
| `stopProgress` | function | Stop progress bar |
| `updateProgressDetails` | function | Update progress detail text |
| `constants` | object | `{ OPERATION, ACTION, TASKS }` |

---

## Built-in Plugins

### `documents`

Loads text documents from a folder. Suitable for Markdown, HTML, or any text format.

**Factory options:**
```js
documents({
  documentsFolder: 'content'  // default: 'documents',
})
```

**Entity properties set:**
- `id`: `/{folder}/{relativePath}` (e.g. `/content/blog/post.md`)
- `uri`: Absolute path to the source file
- `source`: Same as `uri`
- `name`: Path without extension (e.g. `blog/post`)
- `collection`: `'documents'`
- `type`: `'document'`
- `format`: File extension (e.g. `'md'`, `'html'`)
- `content`: File contents as UTF-8 string
- `checksum`: MD5 of file contents

**Watch support:** Yes — adds, changes, and deletes are tracked incrementally.

---

### `files`

Copies or symlinks static files to the output folder.

**Factory options:**
```js
files({
  filesFolder: 'static',   // default: 'files'
  outputFolder: 'assets'   // default: root of outputFolder,
})
```

**Entity properties set:**
- `id`: `/{folder}/{relativePath}`
- `collection`: `'files'`
- `type`: `'file'`
- `format`: File extension
- `destination`: Target path in output folder
- `checksum`: MD5 checksum

**Watch support:** Yes.

---

### `layouts`

Manages HTML/template layouts. Every layout whose pattern hits an entity contributes a render task — multi-match by default, no "best match wins" tiebreaker. One source entity can produce multiple outputs of different formats simply by being matched by multiple layouts.

**Factory options:**
```js
layouts({
  layoutsFolder: 'layouts',    // default: 'layouts'

  // Each pattern that matches contributes a render task. Multi-match:
  // an entity at /blog/welcome.md matches both '@/blog/*' (post) AND
  // '@/**' (default) → two render tasks, one per layout.
  match: {
    '@/blog/*':  'post',
    '@/pages/*': 'page',
    '@/**':      'default',
  },

  autoLayouts: true,           // Auto-match by name (single-match fallback; see below)
  cleanUrls: true              // /page.html → /page/index.html
})
```

**Per-entity selection — `meta.layout` / `meta.layouts`:**

An entity can override match-based assignment via frontmatter:

```yaml
---
layout: post              # single — pick exactly one
---
```

```yaml
---
layouts: [post, post-email]   # multiple — render the entity through each
---
```

`layout` and `layouts` are mutually exclusive — both set is an error. When neither is set, the plugin falls back to `options.match` (multi-match) then `autoLayouts` (single-match peel ladder, see below).

**Auto-layout matching (`autoLayouts: true`) — single-match fallback:**

Only runs when no `options.match` pattern hit the entity. The peel ladder is a most-specific-name search by design and stays first-wins (not multi-match):

| Entity (`entity.name`) | Candidates tried in order | Matches if layout exists at |
|---|---|---|
| `nginx.conf` | `nginx.conf`, `nginx` | `layouts/nginx.conf.*` or `layouts/nginx.*` |
| `styles/post.css` | `styles/post.css`, `styles/post` | `layouts/styles/post.css.*` or `layouts/styles/post.*` |
| `posts/article.md` | `posts/article.md`, `posts/article` | `layouts/posts/article.*` |

Cross-directory auto-matching is intentionally not supported — pair `posts/article.md` with a top-level `article.eta` via `meta.layout: 'article'` or a `layouts.match` rule.

**Per-layout destination override:**

A layout's frontmatter can declare a `destination:` template. The template is Handlebars (path-shaped — substitutions only, no body rendering); it gets `{ entity }` as the context, is compiled once and cached, and the result is path-sanitized (`..` segments rejected). This fully overrides the default `entity.name + .format` derivation (and the cleanUrls folder transform).

```yaml
# layouts/post-card.html.hbs
---
match: '@/blog/*'
destination: '/cards/{{entity.name}}.html'
---
```

```yaml
# Pull from meta
---
destination: '/{{entity.meta.year}}/{{entity.name}}.summary.html'
---
```

```yaml
# Use pagination context (when the sidecar paginates)
---
destination: '/archive/page-{{entity.page}}.html'
---
```

**Destination collisions — fail-fast:**

When two layouts match the same entity AND resolve to the same destination, the plugin logs a named-names error and drops every render task for that entity for the cycle. No winner — disambiguation is the author's call. The build continues for other entities.

```
Layout collision for /documents/blog/welcome.md:
  - post → /blog/welcome.html
  - post-card → /blog/welcome.html
Set a `destination:` override on one of them, or change one's format.
Skipping this entity for the cycle.
```

The common cases that hit this are:
1. Two layouts produce the same format (`.html` from both `post.html.hbs` and `post-card.html.hbs`). Fix: set `destination:` on one.
2. Two layouts with the same name in the same directory — file-system collision, not engine collision. Rename one.

**Postprocess chains:**

A layout's filename encodes a postprocessor chain after the format segment: `<name>.<format>-<post1>[-<post2>...].<template>`. Each `post*` segment names a `mikser-io-post-<name>` plugin. Stages run in order, threading file paths (not buffers) between them; the final extension comes from the last stage's `output:`.

```
layouts/welcome.html-mjml-email.hbs    # renderer → MJML, post-mjml → HTML, post-email → EML
```

Same shape as frontmatter on the source entity:

```yaml
---
postprocessors: [mjml, email]
---
```

See [Rendering → Postprocess](./rendering.md#postprocess) for the per-stage contract and failure semantics.

**Entity properties set on documents:**
- `layout`: The first matched layout (back-compat alias).
- `layouts`: Array of all matched layouts (canonical under multi-match).
- `destination`: Resolved output path — per-task; iterating `entity.layouts` lets you see each.
- `page` / `pages`: Pagination info (if the layout's sidecar provides pages data).

**Entity properties set on layouts:**
- `id`, `uri`, `source`: Path info
- `collection`: `'layouts'`
- `type`: `'layout'`
- `format`: Template format (`'hbs'`, `'html'`, etc.)
- `name`: Layout name without extension
- `template`: Same as `format`

**Watch support:** Yes.

**Href lookups:** The href resolution path goes through `runtime.lookupHref(href)` — a sync function that hits the `meta_href` index on `mikser_entities`. Render workers open their own read-only sqlite handle on first task and call the same primitive; templates stay sync. The `href` render plugin uses this; layout-side code can call it directly.

---

### `assets`

The assets plugin runs **user-authored preset modules** over binary inputs (images, video, audio, anything) and writes processed outputs. Each preset is a plain Node module — whatever you can call from Node, you can run as a build step. No DSL, no constrained options bag, no vendor pipeline to fight with.

That makes the assets plugin **the most powerful primitive in mikser**: an open-ended build-time processing layer with full Node capabilities. Image resizing with sharp, video transcoding with ffmpeg, AI upscaling via Replicate, watermarking with canvas, custom multi-output pipelines composed across all of the above — each is a preset module. The plugin doesn't decide what's possible; the preset does.

#### Config

```js
assets: {
    assetsFolder: 'assets',         // working folder for presets — default 'assets'
    outputFolder: 'public',         // where the processed outputs land — default root

    // Each preset name maps to a list of source globs. A source matches
    // multiple presets if needed (one image → thumbnail + hero + og-card).
    presets: {
        thumbnail: ['/files/images/*.{jpg,png}',  '/resources/**/*.{jpg,png}'],
        hero:      ['/files/images/hero-*.jpg'],
        'video-web': ['/files/videos/*.mp4',       '/resources/**/*.mp4'],
        'image-2x': ['/files/images/*.jpg'],
        upscaled:  ['/files/photos/raw-*.jpg'],
    },
}
```

`presets/<name>.js` next to your `mikser.config.js` is the preset module for that name.

#### Where a preset comes from

A preset name resolves in two places, local first:

1. **`presets/<name>.js`** in your project — the common case.
2. **An npm package `mikser-io-preset-<name>`** — when no local file exists, the plugin resolves the name from your project's `node_modules`. Install a shared preset (`npm install mikser-io-preset-thumbnail`) and reference it by name in `assets.presets` with no local file. Same resolution convention as `post-*` plugins.

A local file always wins over an npm package of the same name — drop `presets/thumbnail.js` to override one preset from a package while leaving the rest. The two have different update lifetimes: local presets reload on file change in watch mode; npm presets are versioned by their package (bump the dependency to update). `node_modules` is never watched.

If a configured preset name resolves to neither a local file nor an npm package, the plugin logs `Preset not found: <name> ...` and skips it — the rest of the build proceeds.

#### Preset module shape

A preset is a default-exported async function. It receives the entity being processed (with `source`, `destination`, `preset`, `name`, etc.), runs whatever code it needs, and resolves (or rejects) when done.

```js
export const revision = 1     // bump to force re-render (cache-bust)
export const format = 'webp'  // output format hint (used in the destination filename)

export default async ({ entity, runtime, logger }) => {
    // entity.source       — input file on disk
    // entity.destination  — where to write the result
    // entity.preset       — config of the matching preset (name, source, options)
    // entity.name         — original entity name (e.g. '/files/images/hero.jpg')
    // runtime / logger    — mikser context, including runtime.options for paths
}
```

That's the whole contract. Three real examples follow.

#### Example 1 — Video transcoding via ffmpeg

A 720×1080 portrait MP4 at 600kbps for the web. fluent-ffmpeg streams progress events back into mikser's logger so the build progress bar reflects encoder progress in real time.

```js
// presets/video-web.js
import ffmpeg from 'fluent-ffmpeg'

export const revision = 7
export const format = 'mp4'

export default ({ entity: { name, source, destination, preset }, logger }) => {
    return new Promise((resolve, reject) => {
        ffmpeg(source)
            .videoCodec('libx264')
            .size('810x1080')
            .videoBitrate(600)
            .outputOptions('-strict -2')
            .on('progress', ({ percent }) =>
                logger.trace(`Progress: [${preset.name}] ${name} ${Math.round(percent)}%`))
            .on('error', reject)
            .on('end', resolve)
            .save(destination)
    })
}
```

10 lines of glue around ffmpeg. Every published video in the catalog gets transcoded; rebuilds skip unchanged inputs because the journal tracks file mtimes; bumping `revision` re-encodes everything (useful when you change the bitrate).

#### Example 2 — Image variants via sharp

Resize + format negotiation. Most projects want srcset variants in WebP and AVIF; this preset emits both with a single sharp pipeline.

```js
// presets/image-2x.js
import sharp from 'sharp'
import { dirname, basename, extname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export const revision = 3

export default async ({ entity: { source, destination }, logger }) => {
    const dir   = dirname(destination)
    const stem  = basename(destination, extname(destination))
    await mkdir(dir, { recursive: true })

    const pipeline = sharp(source).rotate()       // honor EXIF orientation
    // 2× variants for each format
    await Promise.all([
        pipeline.clone().resize({ width: 1600 }).webp({ quality: 85 }).toFile(join(dir, `${stem}@2x.webp`)),
        pipeline.clone().resize({ width: 1600 }).avif({ quality: 60 }).toFile(join(dir, `${stem}@2x.avif`)),
        pipeline.clone().resize({ width: 800  }).webp({ quality: 85 }).toFile(join(dir, `${stem}.webp`)),
        pipeline.clone().resize({ width: 800  }).avif({ quality: 60 }).toFile(join(dir, `${stem}.avif`)),
    ])
    logger.trace('image-2x emitted 4 variants for %s', source)
}
```

One preset, four output files per input image. The render-href plugin can then rewrite `<img src="hero.jpg">` to the `@2x.webp` URL with a fallback `<source>` chain — but that's a render-time concern, not the asset plugin's.

#### Example 3 — AI enhancement via Replicate

The interesting one. Hand a raw photo to a model on Replicate (here, an image upscaler), poll for completion, fetch the result, write it to disk. The preset is a normal Node module — `fetch` is just `fetch`, no special bridging.

```js
// presets/upscaled.js
import { writeFile } from 'node:fs/promises'

export const revision = 2
export const format = 'jpg'

const REPLICATE_MODEL = 'nightmareai/real-esrgan'
const REPLICATE_VERSION = '...'   // pin a model version

export default async ({ entity: { source, destination }, logger }) => {
    // 1. Upload source — Replicate accepts a public URL or base64 data URI
    const data = await readFile(source)
    const dataUri = `data:image/jpeg;base64,${data.toString('base64')}`

    // 2. Kick off the prediction
    const start = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
            'authorization': `Token ${process.env.REPLICATE_TOKEN}`,
            'content-type':  'application/json',
        },
        body: JSON.stringify({
            version: REPLICATE_VERSION,
            input:   { image: dataUri, scale: 4 },
        }),
    }).then(r => r.json())

    // 3. Poll until succeeded
    let prediction = start
    while (prediction.status === 'starting' || prediction.status === 'processing') {
        await new Promise(r => setTimeout(r, 1500))
        prediction = await fetch(start.urls.get, {
            headers: { authorization: `Token ${process.env.REPLICATE_TOKEN}` },
        }).then(r => r.json())
        logger.trace('replicate %s: %s', start.id, prediction.status)
    }
    if (prediction.status !== 'succeeded') {
        throw new Error(`Replicate failed: ${prediction.error}`)
    }

    // 4. Download the result and write it where mikser expects
    const buffer = Buffer.from(await fetch(prediction.output).then(r => r.arrayBuffer()))
    await writeFile(destination, buffer)
}
```

What's unique here is that **none of this required a plugin to mikser**. The preset *is* the plugin code. You can call any third-party service, run any local model (via `@xenova/transformers`, llama.cpp, ONNX runtime, whatever), shell out to anything (`child_process` to a custom binary), or compose multiple steps:

```js
// presets/hero-deluxe.js — multi-step pipeline
import sharp from 'sharp'
import { upscaleViaReplicate } from './_replicate.js'
import { applyWatermark } from './_watermark.js'

export const revision = 1
export default async ({ entity: { source, destination } }) => {
    const upscaled  = await upscaleViaReplicate(source)
    const watermark = await applyWatermark(upscaled, { text: '© Acme Co 2026' })
    await sharp(watermark).resize({ width: 2400 }).avif({ quality: 70 }).toFile(destination)
}
```

This is the property no other SSG / CMS exposes at this level. Astro's `<Image>` resizes; that's it. Hugo's image processing has a fixed set of operations. Sanity's image CDN runs the transforms it decided to support. mikser's preset is whatever you write — including operations that don't exist anywhere else (upscaling specific to your domain, watermarks driven by per-image rules, multi-format outputs with vendor-specific encoders).

#### Composition with `resources`

The assets plugin processes whatever's on disk. Source files don't have to start in your repo — the **resources plugin** (next section) pulls them from external systems (company content servers, S3, vendor APIs) into the working folder so assets can then process them. That composition is where the "advanced pipeline" idea pays off — see the end-of-section example for the full chain.

#### Watch support

Yes — the plugin watches both the source files and the preset modules. Editing a preset re-processes every input that matches it; editing a source re-processes just that input.

---

### `resources`

The resources plugin pulls **external files** into the build so the rest of the pipeline can treat them like local content. It scans entity bodies for URLs that match configured "libraries," downloads each matching URL into the resources folder, and exposes those files to subsequent plugins.

Two things compose with this:

- The **assets plugin** can target `resources/**` in its preset globs — so an externally-hosted MP4 ends up transcoded the same way a locally-committed one would.
- Render templates get `runtime.resource(url)` to rewrite the original URL to its local (cached, deployed-with-the-site) counterpart.

#### Config

```js
resources: {
    resourcesFolder: 'resources',   // working folder — default 'resources'
    outputFolder: '',               // mirror into output — default root

    libraries: {
        // Public CDN — third-party stylesheet, downloaded once and served from your origin
        bootstrap: {
            url:   'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
            match: 'cdn.jsdelivr.net/npm/bootstrap',
        },

        // Company DAM — anything referenced from your content server ends up
        // on disk so the assets plugin can pick it up.
        'company-media': {
            base:  'https://media.acme.internal/',
            match: 'media.acme.internal',
            // Optional auth — runs in Node so any HTTP-shaped credential works
            headers: { authorization: `Bearer ${process.env.DAM_TOKEN}` },
        },
    },
}
```

#### What it does

1. **Scan** — walks loaded entities and finds URL references matching each library's `match` pattern.
2. **Download** — fetches each match into `resourcesFolder/<libraryName>/<path>`, with the original URL path preserved. Existing files are cached by URL + mtime; re-runs only refetch changed files.
3. **Expose** — the downloaded files now live in the working folder; assets/render/catalog plugins see them as if they'd been committed to the repo.
4. **Rewrite** — `runtime.resource(url)` returns the local URL for a given source URL, for use inside render templates: `<link rel="stylesheet" href="${runtime.resource('https://cdn.jsdelivr.net/.../bootstrap.min.css')}">`.

---

### End-to-end pipeline composition

The point of separating `resources` and `assets` is that they compose. A common pattern: editorial team uploads videos to a DAM, content authors reference them by URL in markdown front-matter, the build pulls them in and transcodes them into web-friendly formats — no manual handoff.

```md
---
title: Spring Collection 2026
layout: campaign
meta:
  hero: https://media.acme.internal/campaigns/spring-2026/hero.mp4
---
```

With this config:

```js
// mikser.config.js
import { files, resources, assets, api } from 'mikser-io'

export default {
    plugins: [
        files(),
        resources({
            libraries: {
                'company-media': {
                    base:  'https://media.acme.internal/',
                    match: 'media.acme.internal',
                    headers: { authorization: `Bearer ${process.env.DAM_TOKEN}` },
                },
            },
        }),
        assets({
            presets: {
                'video-web': ['/resources/company-media/**/*.mp4'],
                poster:     ['/resources/company-media/**/*.mp4'],
            },
        }),
        api(),
    ],
}
```

…the build performs:

```
files       → loads the markdown, surfaces meta.hero as a URL string
resources   → matches media.acme.internal, downloads hero.mp4 → resources/company-media/campaigns/spring-2026/hero.mp4
assets      → matches /resources/.../hero.mp4 against the video-web preset → transcodes via ffmpeg
              → matches the same input against the poster preset → extracts a JPEG frame via a sharp/ffmpeg preset
engine      → registers the transcoded mp4 and the poster jpg as asset entities in mikser_entities;
              page templates pull the asset URL via the SDK or runtime.urlFor at render time
api / data  → ships everything to clients via SSE + JSON
```

A content editor uploaded a file to a DAM. The deployment site is serving a transcoded, poster-framed, properly-sized version. Nobody manually exported anything; the next deploy will re-process automatically if either the source or the preset changes.

This is what makes assets + resources together unusual: **the pipeline is bounded only by what you can write in a Node module**, and the inputs to that pipeline can come from anywhere your build has network access to.

---

### `data`

Exports entity data to JSON files for use by front-end JavaScript or APIs.

**Factory options:**
```js
data({
  dataFolder: 'api',           // Output folder for JSON files

  // Export entity list to JSON during beforeRender
  entities: {
    posts: {
      query: entity => entity.collection === 'documents',
      map: entity => ({ title: entity.meta.title, url: entity.name }),
      pick: ['name', 'meta']   // Alternative to map: pick fields
    }
  },

  // Export render context to JSON after rendering
  context: {
    article: {
      query: entity => entity.type === 'document',
      map: (entity, context) => context.data
    }
  },

  // Export catalog queries to JSON during finalize
  catalog: {
    index: {
      query: entity => true,
      map: entity => ({ id: entity.id, title: entity.meta.title })
    }
  },
})
```

---

### `api`

Synchronises data from external REST APIs into entities.

**Factory options:**
```js
api({
  products: {
    collection: 'products',
    type: 'product',
    uri: 'https://api.example.com/products',
    readMany: async (uri) => {
      const res = await fetch(uri)
      return res.json()
    },
    readOne: async (uri, id) => {
      const res = await fetch(`${uri}/${id}`)
      return res.json()
    },
    cron: '*/30 * * * *'   // Refresh every 30 minutes (watch mode only)
  },
})
```

Each item returned by `readMany` becomes an entity. The entity's `meta` is set to the item data, and the `id` field of the item is used as the entity ID. Change detection is done via checksum — only changed items trigger UPDATE operations.

---

### `mapper`

Applies custom transformations to entities during the process phase.

**Factory options:**
```js
mapper({
  mappers: [
    {
      match: '@/blog/*',
      operations: ['CREATE', 'UPDATE'],  // default: CREATE, UPDATE
      map: async (entity, coreAPI) => {
        entity.meta.readTime = Math.ceil(entity.content.split(' ').length / 200)
        return entity
      }
    }
  ],
})
```

---

### `validator`

Validates entities before they are added to the journal.

**Factory options:**
```js
validator({
  validators: [
    {
      match: entity => entity.collection === 'posts',
      operations: ['CREATE', 'UPDATE'],
      validate: async (entry) => {
        if (!entry.entity.meta?.title) return 'Missing title'
        if (!entry.entity.meta?.date) return 'Missing date'
      }
    }
  ],
})
```

---

### `commands`

Runs shell commands at lifecycle hooks.

**Factory options:**
```js
commands({
  finalized: 'rsync -avz out/ user@server:/var/www/',
  load: ['echo "Loading"', 'node scripts/prebuild.js'],
  processed: async (runtime) => {
    return runtime.options.mode === 'production' ? 'npm run minify' : null
  },
})
```

Commands can be a string, an array of strings, or an async function returning a command string. Use `&` suffix for background execution.

---

### `shares`

Creates symlinks from directories into the output folder.

**Factory options:**
```js
shares({
  locations: [
    'node_modules/alpinejs/dist',
    { source: 'vendor/icons', destination: 'icons' }
  ],
})
```

### `api`

Exposes a lightweight HTTP API over the Mikser pipeline. Useful for headless CMS workflows, live preview, and programmatic content management.

**Requires:** `npm install express` and a running server (`--server`, or `setup({ app })`).

**Shape: named endpoints.** Mirrors the `data` and `vector` plugins — you declare named endpoints, each with its own optional `token`, `query` scope, `operations` allowlist, and pagination/render-timeout overrides. Each endpoint mounts under `<base>/<endpointName>`.

```js
api: {
  base: '/api',                    // mount prefix; default '/api'
  pageSize: 10,                    // global default; per-endpoint override below
  renderTimeout: 30_000,           // global default; per-endpoint override below
  endpoints: {
    public: {
      // No token → publicly readable. The query function scopes what
      // this endpoint sees: only published documents, in this example.
      query: e => e.type === 'document' && e.meta?.published,
      operations: ['list'],        // default when no token is set
      cache: true,                 // write-through disk cache for GET
                                   // /entities; see "Per-query disk
                                   // cache" below.
    },
    admin: {
      token: process.env.API_ADMIN_TOKEN,
      // No query → admin sees everything. operations defaults to all
      // when a token is set.
    },
    products: {
      token: process.env.API_PRODUCTS_TOKEN,
      query: e => e.collection === 'products',
      operations: ['list', 'update', 'delete'],
      pageSize: 50,                // override the global pageSize
    },
    render: {
      token: process.env.API_RENDER_TOKEN,
      operations: ['render'],
      renderTimeout: 60_000,
    },
  },
}
```

**Routes per endpoint:**

| Method | Path | Operation | Description |
|--------|------|-----------|-------------|
| `GET` | `/<endpoint>/entities` | `list` | Paginated list with Mongo-style filter operators, sort, and field projection. The endpoint's `query` (if set) ANDs with the request filter. **Cacheable** — see [Per-query disk cache](#per-query-disk-cache-cache-true) below. |
| `POST` | `/<endpoint>/entities/query` | `list` | Same as above but body-based — for `$and`/`$or`, regex, or any filter that doesn't fit in a URL. Not cacheable. |
| `GET` | `/<endpoint>/entities/subscribe` | `subscribe` | Server-Sent Events stream — push create/update/delete events for matching entities as they change. |
| `PUT` | `/<endpoint>/entities` | `update` | Write a file to a collection folder (triggers normal pipeline) |
| `DELETE` | `/<endpoint>/entities` | `delete` | Delete a file from a collection folder |
| `POST` | `/<endpoint>/render` | `render` | Render an entity in memory and return the bytes. The endpoint's `query` (if set) must accept the request entity. |

**`GET /<endpoint>/entities`**

Supports a Mongo-style query language (backed by [sift](https://www.npmjs.com/package/sift)) so the client can filter, sort, project, and paginate exactly the slice it needs — no shipping the whole catalog and filtering in JS.

```
GET /api/public/entities                                    → all in scope, page 1
GET /api/public/entities?meta.published=true&type=document  → equality on multiple fields
GET /api/public/entities?meta.price.$gt=20&meta.price.$lt=80
GET /api/public/entities?meta.tags.$in=blog,news
GET /api/public/entities?meta.summary.$exists=true
GET /api/public/entities?sort=-meta.date,meta.title         → desc by date, then asc by title
GET /api/public/entities?fields=id,meta.title,meta.summary  → projection
GET /api/public/entities?meta.price.$gt=20&sort=-meta.price&limit=10&skip=20
```

Supported operators (URL form `<path>.$<op>=<value>`):

| Operator | Example | Notes |
|---|---|---|
| `$eq` / `$ne` | `meta.published.$ne=true` | |
| `$gt` / `$gte` / `$lt` / `$lte` | `meta.price.$gt=20` | numeric, string, ISO date all work |
| `$in` / `$nin` | `meta.tags.$in=blog,news` | comma-separated |
| `$exists` | `meta.summary.$exists=true` | |
| `$regex` | `meta.title.$regex=^Quarterly` | |

Reserved (non-filter) params: `page`, `limit`, `skip`, `sort`, `fields`.

Type coercion on URL values: `true`/`false` → boolean, `null` → null, numeric strings → number, everything else stays string. For full type control use the POST endpoint below.

Response envelope:
```json
{
  "items": [...],
  "page": 1,
  "limit": 10,
  "total": 47,
  "totalPages": 5,
  "hasNext": true,
  "hasPrev": false
}
```

**`POST /<endpoint>/entities/query`**

For richer queries that don't fit in a URL — `$and`/`$or`, nested operators, explicit types — POST a JSON body. Shape mirrors Mongo `find`:

```json
{
  "filter": {
    "$and": [
      { "meta.published": true },
      { "meta.date": { "$gte": "2025-01-01" } },
      { "$or": [
        { "meta.tags": { "$in": ["product"] } },
        { "type": "category" }
      ]}
    ]
  },
  "sort":   { "meta.date": -1, "meta.title": 1 },
  "fields": ["id", "meta.title", "meta.summary"],
  "page":   1,
  "limit":  20
}
```

Use dotted keys (`"meta.price": { "$gt": 20 }`) — sift treats nested object literals as deep-equality, not path matches. Same as standard Mongo.

The endpoint's configured `query` (in JS) still ANDs as the outer scope: a `public` endpoint restricted to published documents stays restricted, even if the client sends a filter that asks for drafts.

**`PUT /<endpoint>/entities`**

Writes content to a file in a collection folder. The file change is picked up by the watcher and runs through the normal pipeline.

```json
{ "collection": "documents", "relativePath": "blog/new-post.md", "content": "---\ntitle: Hello\n---\n\nContent here." }
```

**`DELETE /<endpoint>/entities`**

```json
{ "collection": "documents", "relativePath": "blog/old-post.md" }
```

**`POST /<endpoint>/render`**

```json
{
  "id": "/documents/blog/preview.md",
  "collection": "documents",
  "type": "document",
  "format": "md",
  "meta": { "title": "Preview", "layout": "post" },
  "content": "# Preview",
  "options": { "save": false, "catalog": false }
}
```

`options` is optional. Strict opt-outs via the literal `false`:
- `options.catalog: false` — prune the catalog row after render
- `options.save: false` — skip the final disk write (bytes still in the response)

**`GET /<endpoint>/entities/subscribe`**

Open a Server-Sent Events stream that pushes change events for entities matching a filter. Same filter syntax as `GET /entities` (operator-suffixed URL params). The endpoint's `query` (if set) still ANDs as the outer scope.

```
GET /api/public/entities/subscribe?type=document&meta.published=true
```

Event stream:

```
event: init
data: {"subscriptionId":"sub_...","endpoint":"public"}

event: create
data: {"id":"/documents/en/foo.md","entity":{...}}

event: update
data: {"id":"/documents/en/foo.md","entity":{...}}

event: delete
data: {"id":"/documents/en/foo.md"}

event: heartbeat
data: {}
```

Heartbeats fire every 25 seconds so idle proxies don't close the connection. On client disconnect (or AbortController abort) the server cleans up immediately.

Compose with the list endpoint to get an initial snapshot, then stream forward changes:

```js
const { items } = await fetch('/api/public/entities/query', { ... }).then(r => r.json())
items.forEach(addToView)

const es = new EventSource('/api/public/entities/subscribe?type=document')
es.addEventListener('create', ({ data }) => addToView(JSON.parse(data).entity))
es.addEventListener('update', ({ data }) => updateInView(JSON.parse(data).entity))
es.addEventListener('delete', ({ data }) => removeFromView(JSON.parse(data).id))
```

Or with the [`mikser-io-sdk-api`](https://github.com/almero-digital-marketing/mikser-io-sdk-api) `watch()` async iterator — fetch-based so it works in browsers, Node 18+, Deno, Bun, Workers.

Events fire on **every** process cycle — both file-watcher–driven changes (`--watch`) and programmatic writes through `PUT /entities`. No second mechanism to wire up.

**Authentication:**

When an endpoint declares a `token`, every request to that endpoint must carry `Authorization: Bearer <token>`. Endpoints without a token are open. Each endpoint owns its own token — a leak only burns one endpoint's scope.

**Default `operations`:**

| `token` set? | default `operations` |
|---|---|
| No (public) | `['list']` — read-only |
| Yes (gated) | `['list', 'update', 'delete', 'render', 'subscribe']` — full |

`subscribe` is excluded from the public default because each open connection has ongoing resource cost — public endpoints must explicitly opt in. Token-gated endpoints get it by default (token presence implies trust).

Always overridable with explicit `operations`. A request to an operation outside the allowlist returns `403`; a missing/wrong token returns `401`.

**Without `api.endpoints` configured**, the plugin logs a warning and mounts nothing — you must declare at least one endpoint to use the API.

#### Per-query disk cache (`cache: true`)

Setting `cache: true` on an endpoint turns every `GET /<endpoint>/entities?...` response into a write-through cache file under `out/<base>/<endpoint>/entities/`. A reverse proxy in front of mikser can serve those files as failover when the live API is unreachable — same URL, transparent to the SDK, no special client config.

```js
api: {
  endpoints: {
    sitemap: {
      query: e => e.type === 'document' && e.meta?.published && e.meta?.component,
      operations: ['list', 'subscribe'],
      cache: true,                    // ← engages the disk cache
    },
  },
}
```

See **[Caching and reverse-proxy failover](./caching.md)** for the full story: file layout, working nginx config (stock primitives, no Lua), Caddy / Cloudflare Workers / Apache equivalents, invalidation model, what isn't cached, and honest trade-offs.

---

## npm Plugin Packages

Third-party plugins can be published as npm packages named `mikser-io-{name}`:

```bash
npm install mikser-io-sharp
```

```js
export default {
  plugins: ['sharp']
}
```

Mikser will look for the package at `node_modules/mikser-io-sharp/index.js`.
