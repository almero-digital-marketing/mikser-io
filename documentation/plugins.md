# Plugins

Plugins are the primary way to extend Mikser. Every content source, transformation, and output format is implemented as a plugin.

## Loading Plugins

Plugins are listed in the config under `plugins`:

```js
export default {
  plugins: ['documents', 'layouts', 'data', 'my-custom-plugin']
}
```

Or passed as CLI arguments:

```bash
mikser --plugins documents layouts data
```

### Resolution Order

For each plugin name, Mikser looks in these locations, in order:

1. `src/plugins/{name}.js` — built-in plugins
2. `{workingFolder}/plugins/{name}.js` — project-local plugins
3. `{workingFolder}/node_modules/mikser-io-{name}/index.js` — npm packages installed in the working folder
4. Node module resolution (`createRequire`) starting from the working folder — finds `mikser-io-{name}` in any ancestor `node_modules`, matching how `import` works

Render plugins (names starting with `render-`) follow the same four-step resolution but are loaded by the render worker, not the core. They aren't listed in `plugins`.

---

## Writing a Custom Plugin

A plugin is a JS module that exports a default factory function. The factory receives the full Mikser API and returns an optional object of plugin exports.

```js
// plugins/my-plugin.js
export default ({
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
  constants: { OPERATION, ACTION }
}) => {
  const collection = 'posts'
  const type = 'post'

  onLoaded(async () => {
    const logger = useLogger()
    logger.info('My plugin loaded')
  })

  onImport(async () => {
    // Scan and import entities
    await createEntity({
      id: '/posts/hello',
      collection,
      type,
      format: 'md',
      name: 'hello',
      meta: { title: 'Hello World' }
    })
  })

  // Export plugin's public API
  return { collection, type }
}
```

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
| `useJournal` | async generator | Iterate journal entries |
| `findEntity` | function | Find one entity from catalog |
| `findEntities` | function | Find multiple entities from catalog |
| `addEntry` | function | Low-level journal insert |
| `updateEntry` | function | Low-level journal update |
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

**Config:**
```js
documents: {
  documentsFolder: 'content'  // default: 'documents'
}
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

**Config:**
```js
files: {
  filesFolder: 'static',   // default: 'files'
  outputFolder: 'assets'   // default: root of outputFolder
}
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

Manages HTML/template layouts. Layouts are assigned to documents and used during rendering.

**Config:**
```js
layouts: {
  layoutsFolder: 'layouts',    // default: 'layouts'

  // Explicit pattern-to-layout mapping
  match: {
    '@/blog/*': 'blog.hbs',
    '@/pages/*': 'page.hbs',
    '@/**': 'default.hbs'      // Fallback
  },

  autoLayouts: true,           // Auto-match entity to layout within same directory namespace
  cleanUrls: true              // /page.html → /page/index.html
}
```

**Auto-layout matching (`autoLayouts: true`):**

For each entity, Mikser tries lookups in the entity's directory namespace, peeling trailing dot-segments off the basename. The first candidate that names an existing layout wins:

| Entity (`entity.name`) | Candidates tried in order | Matches if layout exists at |
|---|---|---|
| `nginx.conf` | `nginx.conf`, `nginx` | `layouts/nginx.conf.*` or `layouts/nginx.*` |
| `styles/post.css` | `styles/post.css`, `styles/post` | `layouts/styles/post.css.*` or `layouts/styles/post.*` |
| `posts/article.md` | `posts/article.md`, `posts/article` | `layouts/posts/article.*` |

Cross-directory auto-matching is intentionally not supported — pair `posts/article.md` with a top-level `article.eta` via `meta.layout: 'article'` or a `layouts.match` rule.

**Entity properties set on documents:**
- `layout`: The matched layout entity object
- `destination`: Resolved output path (applying cleanUrls)
- `page` / `pages`: Pagination info (if layout provides pages data)

**Entity properties set on layouts:**
- `id`, `uri`, `source`: Path info
- `collection`: `'layouts'`
- `type`: `'layout'`
- `format`: Template format (`'hbs'`, `'html'`, etc.)
- `name`: Layout name without extension
- `template`: Same as `format`

**Watch support:** Yes.

**Sitemap:** Maintains `runtime.state.layouts.sitemap` — a mapping from entity href to entity, used by the `href` render plugin for link resolution.

---

### `assets`

Transforms images and other binary assets through preset processors.

**Config:**
```js
assets: {
  assetsFolder: 'assets',      // default: 'assets'
  outputFolder: '',            // default: root
  presets: {
    'thumbnail': ['@/images/*'],
    'hero': ['@/images/hero-*']
  }
}
```

**Preset modules** (placed in your presets folder as `.js` files):

```js
// presets/thumbnail.js
export const revision = 1      // Increment to force re-render
export const format = 'webp'   // Output format
export const options = { width: 300 }

export default async ({ entity, runtime, logger }) => {
  // Transform the asset — return the output file path
  const outputPath = entity.destination
  await sharp(entity.uri).resize(300).webp().toFile(outputPath)
  return outputPath
}
```

**Watch support:** Yes (watches presets folder).

---

### `resources`

Downloads and caches external CDN resources locally.

**Config:**
```js
resources: {
  resourcesFolder: 'resources',
  outputFolder: '',
  libraries: {
    'bootstrap': {
      url: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
      match: 'cdn.jsdelivr.net/npm/bootstrap'
    }
  }
}
```

**What it does:**
1. Scans entity content for URLs matching `libraries[*].match`
2. Downloads the resource to `resourcesFolder/libraryName/`
3. Symlinks the folder into the output
4. Makes `runtime.resource(url)` available in render templates for URL mapping

---

### `data`

Exports entity data to JSON files for use by front-end JavaScript or APIs.

**Config:**
```js
data: {
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
  }
}
```

---

### `api`

Synchronises data from external REST APIs into entities.

**Config:**
```js
api: {
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
  }
}
```

Each item returned by `readMany` becomes an entity. The entity's `meta` is set to the item data, and the `id` field of the item is used as the entity ID. Change detection is done via checksum — only changed items trigger UPDATE operations.

---

### `mapper`

Applies custom transformations to entities during the process phase.

**Config:**
```js
mapper: {
  mappers: [
    {
      match: '@/blog/*',
      operations: ['CREATE', 'UPDATE'],  // default: CREATE, UPDATE
      map: async (entity, coreAPI) => {
        entity.meta.readTime = Math.ceil(entity.content.split(' ').length / 200)
        return entity
      }
    }
  ]
}
```

---

### `validator`

Validates entities before they are added to the journal.

**Config:**
```js
validator: {
  validators: [
    {
      match: entity => entity.collection === 'posts',
      operations: ['CREATE', 'UPDATE'],
      validate: async (entry) => {
        if (!entry.entity.meta?.title) return 'Missing title'
        if (!entry.entity.meta?.date) return 'Missing date'
      }
    }
  ]
}
```

---

### `commands`

Runs shell commands at lifecycle hooks.

**Config:**
```js
commands: {
  finalized: 'rsync -avz out/ user@server:/var/www/',
  load: ['echo "Loading"', 'node scripts/prebuild.js'],
  processed: async (runtime) => {
    return runtime.options.mode === 'production' ? 'npm run minify' : null
  }
}
```

Commands can be a string, an array of strings, or an async function returning a command string. Use `&` suffix for background execution.

---

### `shares`

Creates symlinks from directories into the output folder.

**Config:**
```js
shares: {
  locations: [
    'node_modules/alpinejs/dist',
    { source: 'vendor/icons', destination: 'icons' }
  ]
}
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
| `GET` | `/<endpoint>/entities` | `list` | Paginated list with Mongo-style filter operators, sort, and field projection. The endpoint's `query` (if set) ANDs with the request filter. |
| `POST` | `/<endpoint>/entities/query` | `list` | Same as above but body-based — for `$and`/`$or`, regex, or any filter that doesn't fit in a URL. |
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

**Authentication:**

When an endpoint declares a `token`, every request to that endpoint must carry `Authorization: Bearer <token>`. Endpoints without a token are open. Each endpoint owns its own token — a leak only burns one endpoint's scope.

**Default `operations`:**

| `token` set? | default `operations` |
|---|---|
| No (public) | `['list']` — read-only |
| Yes (gated) | `['list', 'update', 'delete', 'render']` — full |

Always overridable with explicit `operations`. A request to an operation outside the allowlist returns `403`; a missing/wrong token returns `401`.

**Without `api.endpoints` configured**, the plugin logs a warning and mounts nothing — you must declare at least one endpoint to use the API.

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
