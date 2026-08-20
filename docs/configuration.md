# Configuration

Mikser is configured via a `mikser.config.js` file in your working folder, plus CLI arguments. Programmatic options passed to `setup()` take highest precedence.

## Priority Order

1. Options passed directly to `setup(options)` — highest priority
2. CLI arguments (`mikser --watch`, etc.)
3. `mikser.config.js` — lowest priority

## Config File

The config file must be an ES module exporting either an object or an async function. Plugins are imported by name and called as factories; each entry in `plugins: []` is a factory return value (lifecycle plugin closure or renderer/postprocessor descriptor). Per-plugin options live at the factory call site — there are no `runtime.config.<plugin>` blocks anymore (ADR-0010).

```js
// mikser.config.js — object form
import { documents, layouts } from 'mikser-io'

export default {
  plugins: [
    documents(),
    layouts({ cleanUrls: true }),
  ],
}
```

```js
// mikser.config.js — function form (receives the runtime singleton)
import { documents, layouts } from 'mikser-io'

export default async (runtime) => ({
  plugins: [
    documents(),
    layouts(),
  ],
  outputFolder: runtime.options.mode === 'production' ? 'dist' : 'out',
})
```

## Core Options

These options are part of `runtime.options` and apply to the engine itself.

| Option | CLI Flag | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `workingFolder` | `-i, --working-folder` | string | `./` | Root folder of the project. All other paths are relative to this. |
| `outputFolder` | `-o, --output-folder` | string | `out` | Folder where rendered output is written. |
| `runtimeFolder` | `-e, --runtime-folder` | string | `runtime` | Folder for temporary files. The engine's sqlite substrate lives at `runtime/mikser.sqlite` (entities, refs, snapshots, journal, schema-version meta all in one file). |
| `plugins` | — | factory-call[] | `[]` | Array of factory returns. Import the factory by name and call it: `plugins: [documents(), layouts({ cleanUrls: true })]`. Config-only — there's no `--plugins` CLI flag under v9 because identifiers can't be passed via the command line (ADR-0010). |
| `config` | `-c, --config` | string | `./mikser.config.js` | Path to the config file. |
| `mode` | `-m, --mode` | string | `development` | Runtime mode, accessible as `runtime.options.mode`. |
| `clear` | `-r, --clear` | boolean | `false` | Delete `outputFolder` and `runtimeFolder` before each run. |
| `watch` | `-w, --watch` | boolean | `false` | Watch source folders for changes and rebuild incrementally. |
| `force` | `-f, --force` | boolean | `false` | Rebuild everything; disable incremental dispatch. |
| `resume` | `-R, --resume` | boolean | `false` | Continue from journal entries left by a previous interrupted run; skip the initial filesystem scan. The journal table survives crashes, so an interrupted cycle can be picked up by re-running with `--resume`. |
| `verify` | `--verify` | boolean | `false` | Verify the output folder against the manifest snapshot — report drift instead of building. |
| `debug` | `-d, --debug` | boolean | `false` | Enable debug-level logging. |
| `trace` | `-t, --trace` | boolean | `false` | Enable trace-level logging (very verbose). |
| `threads` | — | number | `4` | Worker thread count for the Piscina pools (`renderWorkers`, `postprocessWorkers`). Both pools are lazy (`minThreads: 0` + `idleTimeout: 30_000`) so INLINE-only workloads spin up zero workers. |
| `server` | `-s, --server [port]` | number\|boolean | — | When set, the engine creates a shared Express app on `runtime.options.app` and listens on the given port (default `3001`) after all plugins have mounted their routes. Plugins like `api` attach to it instead of starting their own server. The `outputFolder` is also served as a static catch-all route at `/` (plugin routes match first; anything that doesn't match falls through to the rendered output). Requires `express` to be installed. |
| `cors` / `no-cors` | `--cors` / `--no-cors` | boolean | — | Toggle CORS on the engine's shared Express app. See `src/server.js` for the extensible header arrays plugins push onto. |
| `server.requestTimeout` | — | number | node default (`300000`) | Milliseconds a single request may take, set on the underlying `http.Server`. Node's 5-minute default is effectively an **upload size limit expressed in seconds** — a large file over a slow link is indistinguishable from a stalled request, so it is cut off and the caller sees a truncated write rather than a readable error. Only reachable from the `http.Server`, which the engine owns, so a plugin that mounts an upload surface (`mikser-io-webdav`, `forms` with large attachments) cannot raise it for itself. `0` disables the cap: reasonable on a trusted-network build server, bad facing the internet, where it removes the only bound on how long a client can hold a connection open doing nothing. `headersTimeout` is clamped to stay at or below it. The server is also exposed as `runtime.options.httpServer`. |
| `url` | `-u, --url <url>` | string | — | Public URL where this mikser is reachable (e.g. `https://blog.me.com`). Validated, trailing slash stripped, stamped on `runtime.options.url`. Read by webhook-capable plugins for push-vs-poll gating (`url.startsWith('https://')`); used by anything that surfaces absolute URLs externally — MCP preview URLs returned to agents, forms share links, email tracking pixels. Plugins that just need internal URLs keep using `runtime.options.port`. |

## Engine Substrate

The catalog, inverse-ref graph, render snapshot manifest, and per-cycle
journal all share one sqlite file at `{runtimeFolder}/mikser.sqlite` (see
[ADR-0009](./decisions/0009-database-engine-substrate.md)).

### `database`

```js
export default {
  database: {
    filename: 'mikser.sqlite',  // Default. Resolved under runtimeFolder
                                // unless absolute.
    // filename: ':memory:'     // In-process scratch substrate; no resume,
                                // no cross-run persistence.
  }
}
```

### `catalog`

```js
export default {
  catalog: {
    cache: {
      size: 10000  // findById LRU size. Default 10000.
    },
    expand: {       // Caps for $-ref expansion (ADR-0007)
      maxDepth: 5,
      maxPaths: 20,
      maxResolved: 100
    }
  }
}
```

## Plugin Configuration

Each plugin reads its own key from `runtime.config`. Plugin configs can also be split into separate files placed in a `config/` folder inside your working folder.

```
project/
└── config/
    ├── documents.config.js
    ├── layouts.config.js
    └── data.config.js
```

Each file follows the same object-or-function convention as the main config:

```js
// config/layouts.config.js
export default {
  layoutsFolder: 'templates',
  cleanUrls: true
}
```

Plugin configs are merged into `runtime.config[pluginName]`.

## Built-in Plugin Options

### `documents`

```js
export default {
  documents: {
    documentsFolder: 'content'  // Folder to scan. Default: 'documents'
  }
}
```

### `files`

```js
export default {
  files: {
    filesFolder: 'static',      // Source folder. Default: 'files'
    outputFolder: 'assets'      // Output subfolder inside outputFolder. Default: root
  }
}
```

### `layouts`

```js
export default {
  layouts: {
    layoutsFolder: 'templates', // Folder containing layout files. Default: 'layouts'

    // Map URL patterns to layout filenames
    match: {
      '@/blog/*': 'blog.hbs',
      '@/pages/*': 'page.hbs'
    },

    autoLayouts: true,          // Match entity to layout within the same directory namespace; peels trailing dot-segments off basename
    cleanUrls: true             // Convert /page.html to /page/index.html
  }
}
```

#### Layout frontmatter

Layouts can carry YAML frontmatter just like documents. The `front-matter` plugin runs over any entity that has parseable `entity.content` — and now that includes layouts, because the layouts plugin reads the file body into `entity.content` at sync/import time. Parsed metadata lands on `entity.meta` and any plugin can consume it without coordinating with the layouts plugin.

```hbs
---
match: "@/articles/*"
mcpUi:
  mode: preview
  description: "Article preview with approve/reject controls"
  actions: ["approve", "reject"]
  sandbox: ["allow-scripts"]
seo:
  ogImage: "/og/default.png"
---
<!DOCTYPE html>
<html>
  <body>{{document.meta.title}}</body>
</html>
```

The renderers (`render-hbs`, `render-eta`, `render-liquid`) consume the stripped body from `entity.layout.content` — the YAML never reaches the template engine. Consumed today: `meta.mcpUi` (by the [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp) plugin's `mikser_preview_ui` tool — see the plugin's README). Other namespaces (`seo`, `performance`, `a11y`) are reserved for future plugins; nothing breaks if you author your own keys there before the consuming plugin exists.

ECT layouts (`mikser-io-render-ect`) still file-load via ECT's own resolver — YAML at the top of `.ect` files renders as literal text. Pick `hbs` / `eta` / `liquid` for layouts that need self-describing metadata.

### `assets`

```js
export default {
  assets: {
    assetsFolder: 'assets',     // Source folder for assets. Default: 'assets'
    outputFolder: '',           // Output subfolder. Default: root

    // Preset definitions: preset name → match patterns (and optional config).
    // Two shapes accepted:
    presets: {
      // 1. Bare string or array — backwards-compatible match patterns.
      'thumbnail': ['@/images/*'],
      'hero': '@/images/hero*',

      // 2. Object with `match` and per-preset `options` — options merge
      //    over the preset module's own defaults at render time
      //    (config-side overrides win on overlap).
      'medium-image': {
        match: ['@/images/*', '@/files/photos/*'],
        options: {
          width: 800,
          height: 600,
          quality: 80,
        },
      },
    }
  }
}
```

Per-preset `options` from config let a generic preset module (e.g. a `resize` package that reads `options.width` / `options.height`) be reused with different parameters per project — no need to fork the module for each variant. Module-side defaults under `options` still apply for anything the config doesn't override.

Caveat: changing config-side options doesn't automatically invalidate already-rendered assets on disk. Bump the preset module's `revision` export to force a re-render, or run `mikser --clear`.

### `resources`

```js
export default {
  resources: {
    resourcesFolder: 'resources', // Local download folder. Default: 'resources'
    outputFolder: '',             // Output subfolder. Default: root

    // Map CDN URLs to local library names
    libraries: {
      'bootstrap': {
        url: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
        match: 'cdn.jsdelivr.net/npm/bootstrap'
      }
    }
  }
}
```

### `data`

```js
export default {
  data: {
    dataFolder: 'data',         // Output folder for JSON files. Default: 'data'

    // Export individual entities to JSON
    entities: {
      documents: {
        query: entity => entity.collection === 'documents',
        map: entity => ({ title: entity.meta.title, url: entity.name }),
        pick: ['name', 'meta.title']  // Optional: pick specific fields
      }
    },

    // Export render context to JSON after rendering
    context: {
      pages: {
        query: entity => entity.collection === 'documents',
        map: (entity, context) => context.data
      }
    },

    // Export full catalog query results to JSON
    catalog: {
      allDocuments: {
        query: entity => entity.collection === 'documents',
        map: entity => ({ id: entity.id, title: entity.meta.title })
      }
    }
  }
}
```

### `mapper`

```js
export default {
  mapper: {
    mappers: [
      {
        match: '@/blog/*',             // Entity match pattern
        operations: ['CREATE', 'UPDATE'],
        map: async (entity, core) => {
          entity.meta.slug = entity.name.split('/').pop()
          return entity
        }
      }
    ]
  }
}
```

### `validator`

```js
export default {
  validator: {
    validators: [
      {
        match: '@/blog/*',
        operations: ['CREATE', 'UPDATE'],
        validate: async (entry) => {
          if (!entry.entity.meta?.title) return 'missing title'
          // Return a message string if invalid, nothing if valid
        }
      }
    ]
  }
}
```

### `commands`

```js
export default {
  commands: {
    // Run shell commands at any lifecycle hook
    load: 'echo Loading...',
    finalized: ['npm run compress', 'npm run deploy'],

    // Commands can also be async functions
    processed: async (runtime) => {
      if (runtime.options.mode === 'production') {
        return 'npm run optimize'
      }
    }
  }
}
```

Available hook names: `load`, `loaded`, `import`, `imported`, `process`, `processed`, `persist`, `persisted`, `beforeRender`, `render`, `afterRender`, `cancel`, `cancelled`, `finalize`, `finalized`.

### `shares`

```js
export default {
  shares: {
    // Symlink items into the output folder
    locations: [
      'node_modules/bootstrap/dist',              // String: symlink by name
      { source: 'vendor/fonts', destination: 'fonts' }  // Object: custom destination
    ]
  }
}
```

### `api`

The api plugin exposes the catalog over HTTP via one or more **named
endpoints**, each with its own query scope, allowed operations, and
optional bearer token. Endpoints mount under `<base>/<name>` (default
`/api/<name>`); for example the `public` endpoint below ends up at
`/api/public/entities`.

The plugin mounts onto an existing Express app — it does **not**
create one. Provide the app either via the `--server` CLI flag (engine
creates one) or by passing `app` to `setup()` programmatically. If
neither is in place when the plugin loads, it fails fast with an
actionable error.

```js
export default {
  api: {
    // Global defaults — every endpoint can override these.
    base: '/api',          // Mount path under runtime.options.app. Default: '/api'
    pageSize: 10,          // Default page size for list / query. Default: 10
    renderTimeout: 30000,  // Max ms to wait for POST /render to complete. Default: 30000

    // Named endpoints. Each becomes /api/<name>/entities... and gets
    // its own query scope, token, and operation allow-list.
    endpoints: {
      // Open read-only endpoint. No token → defaults to ['list'] only.
      // Add 'subscribe' explicitly to expose the SSE event stream so
      // SDK clients can keep useDocument / useDocuments live.
      public: {
        query: e => e.type === 'document' && e.meta?.published,
        operations: ['list', 'subscribe'],
      },

      // Token-gated endpoint. With a token set, the default operations
      // open up to ['list','update','delete','render','subscribe'] —
      // override with an explicit `operations` array if you need a
      // narrower surface.
      admin: {
        token: process.env.ADMIN_TOKEN,
        // operations defaults to full set when a token is present
        // pageSize / renderTimeout overrideable per endpoint:
        pageSize: 50,
      },

      // Render endpoint that ships HTML on demand. The render operation
      // pipes the catalog entity through the configured renderer chain
      // (render-hbs, render-eta, etc.) and returns the produced output.
      render: {
        token: process.env.RENDER_TOKEN,
        operations: ['render'],
        renderTimeout: 60000,
      },
    },
  },
}
```

**Operations** (`ep.operations`) — pick any subset:
- `list` — `GET /api/<name>/entities`, `POST /api/<name>/entities/query`
- `update` — `PUT /api/<name>/entities/:id`
- `delete` — `DELETE /api/<name>/entities/:id`
- `render` — `POST /api/<name>/entities/:id/render`
- `subscribe` — `GET /api/<name>/entities/subscribe` (Server-Sent Events stream; SDK clients (`sdk-api`'s `client.live(...)`) consume this for live `useDocument`/`useDocuments` updates)

When `token` is unset, the default operation set is `['list']` (safest open shape). When `token` is set, it widens to `['list', 'update', 'delete', 'render', 'subscribe']`. Explicit `operations` always wins.

**Auth** — endpoints with `token` require `Authorization: Bearer <token>` on every request. Endpoints without `token` are open.

Requires `express` to be installed: `npm install express`. Port and
listen lifecycle live on the engine side (see `--server`) or with the
caller (when they supplied their own app).
