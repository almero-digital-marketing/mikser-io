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

### `assets`

```js
export default {
  assets: {
    assetsFolder: 'assets',     // Source folder for assets. Default: 'assets'
    outputFolder: '',           // Output subfolder. Default: root

    // Preset definitions: preset name → array of entity match patterns
    presets: {
      'thumbnail': ['@/images/*'],
      'hero': ['@/images/hero*']
    }
  }
}
```

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
    dataFolder: 'api',          // Output folder for JSON files

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

### `api`

```js
export default {
  api: {
    posts: {
      collection: 'posts',
      type: 'post',
      uri: 'https://api.example.com/posts',
      
      // Function to fetch all items (returns array)
      readMany: async (uri) => {
        const res = await fetch(uri)
        return res.json()
      },
      
      // Function to fetch a single item
      readOne: async (uri, id) => {
        const res = await fetch(`${uri}/${id}`)
        return res.json()
      },
      
      // Cron schedule for automatic refresh
      cron: '0 * * * *'  // Every hour
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

```js
export default {
  api: {
    port: 3001,           // Port to listen on. Default: 3001
    token: 'my-secret',   // Bearer token required on all requests. Default: none (open)
    pageSize: 10,         // Default page size for GET /entities. Default: 10
    renderTimeout: 30000  // Max ms to wait for POST /render to complete. Default: 30000
  }
}
```

Requires `express` to be installed: `npm install express`.
