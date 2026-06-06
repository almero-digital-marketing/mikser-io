# Configuration

Mikser is configured via a `mikser.config.js` file in your working folder, plus CLI arguments. Programmatic options passed to `setup()` take highest precedence.

## Priority Order

1. Options passed directly to `setup(options)` — highest priority
2. CLI arguments (`mikser --watch`, etc.)
3. `mikser.config.js` — lowest priority

## Config File

The config file must be an ES module exporting either an object or an async function:

```js
// mikser.config.js — object form
export default {
  plugins: ['documents', 'layouts'],
  layouts: {
    cleanUrls: true
  }
}
```

```js
// mikser.config.js — function form (receives the runtime singleton)
export default async (runtime) => {
  return {
    plugins: ['documents', 'layouts'],
    outputFolder: runtime.options.mode === 'production' ? 'dist' : 'out'
  }
}
```

## Core Options

These options are part of `runtime.options` and apply to the engine itself.

| Option | CLI Flag | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `workingFolder` | `-i, --working-folder` | string | `./` | Root folder of the project. All other paths are relative to this. |
| `outputFolder` | `-o, --output-folder` | string | `out` | Folder where rendered output is written. |
| `runtimeFolder` | `-e, --runtime-folder` | string | `runtime` | Folder for temporary files (SQLite journal, catalog snapshot, render details). |
| `plugins` | `-p, --plugins` | string[] | `[]` | List of plugins to load. |
| `config` | `-c, --config` | string | `./mikser.config.js` | Path to the config file. |
| `mode` | `-m, --mode` | string | `development` | Runtime mode, accessible as `runtime.options.mode`. |
| `clear` | `-r, --clear` | boolean | `false` | Delete `outputFolder` and `runtimeFolder` before each run. |
| `watch` | `-w, --watch` | boolean | `false` | Watch source folders for changes and rebuild incrementally. |
| `debug` | `-d, --debug` | boolean | `false` | Enable debug-level logging. |
| `trace` | `-t, --trace` | boolean | `false` | Enable trace-level logging (very verbose). |
| `threads` | — | number | `4` | Number of worker threads for parallel rendering. |
| `server` | `-s, --server [port]` | number\|boolean | — | When set, the engine creates a shared Express app on `runtime.options.app` and listens on the given port (default `3001`) after all plugins have mounted their routes. Plugins like `api` attach to it instead of starting their own server. The `outputFolder` is also served as a static catch-all route at `/` (plugin routes match first; anything that doesn't match falls through to the rendered output). Requires `express` to be installed. |

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

The renderers (`render-hbs`, `render-eta`, `render-liquid`) consume the stripped body from `entity.layout.content` — the YAML never reaches the template engine. Consumed today: `meta.mcpUi` (by the `preview` plugin's `mikser_preview_ui` tool — see [mcp.md](./mcp.md#layout-frontmatter-and-mcp-ui)). Other namespaces (`seo`, `performance`, `a11y`) are reserved for future plugins; nothing breaks if you author your own keys there before the consuming plugin exists.

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
