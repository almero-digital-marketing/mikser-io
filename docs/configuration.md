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
| `config` | `-c, --config` | string | `./mikser.config.js` | Path to the config file, relative to `workingFolder` like every other path — so `-c prod.config.js` means the one in the folder you pointed at, and repeating the working folder in the path doubles it. A project with no config file at the default location runs on defaults; a path given here that does not exist is an error, because the alternative is a green build with an empty output folder. |
| `mode` | `-m, --mode` | string | `development` | Runtime mode, accessible as `runtime.options.mode`. |
| `clear` | `-r, --clear` | boolean | `false` | Delete `outputFolder` and `runtimeFolder` before each run. |
| `watch` | `-w, --watch` | boolean | `false` | Watch source folders for changes and rebuild incrementally. |
| `force` | `-f, --force` | boolean | `false` | Rebuild everything; disable incremental dispatch. |
| `resume` | `-R, --resume` | boolean | `false` | Continue from journal entries left by a previous interrupted run; skip the initial filesystem scan. The journal table survives crashes, so an interrupted cycle can be picked up by re-running with `--resume`. |
| `verify` | `--audit-output` | boolean | `false` | Verify the output folder against the manifest snapshot — report drift instead of building. |
| `debug` | `-d, --debug` | boolean | `false` | Enable debug-level logging. |
| `trace` | `-t, --trace` | boolean | `false` | Enable trace-level logging (very verbose). |
| `threads` | — | number | `4` | Worker thread count for the Piscina pools (`renderWorkers`, `postprocessWorkers`). Both pools are lazy (`minThreads: 0` + `idleTimeout: 30_000`) so INLINE-only workloads spin up zero workers. |
| `server` | `-s, --server [port]` | number\|boolean | — | When set, the engine creates a shared Express app on `runtime.options.app` and listens on the given port (default `3001`) after all plugins have mounted their routes. Plugins like `api` attach to it instead of starting their own server. The `outputFolder` is also served as a static catch-all route at `/` (plugin routes match first; anything that doesn't match falls through to the rendered output). Requires `express` to be installed. |
| `junk` | — | array\|false | built-in list | OS and file-manager litter, filtered out of both the scan and the watcher. The dot-prefixed files (`.DS_Store`, `._*`) were already invisible — globby defaults to `dot: false` and the watcher ignores leading dots — but the Windows ones are **not** dotfiles: `Thumbs.db` and `desktop.ini` were measurably scanned *and* watched, and became entities. The list is deliberately conservative (OS/file-manager artifacts and application lock files only, no `*.tmp`, `*.bak` or editor backups), because a filter that silently drops content is worse than the litter it prevents. `false` disables it; an array replaces it. See `isJunkPath` / `JUNK_IGNORE` in `src/utils.js`. Plugins that write metadata next to content add their own patterns with `registerJunk({ ignore, match })` — the engine provides the mechanism and the plugin the knowledge of what its files are called (`mikser-io-drive` registers `*.nephelemeta`). Plugin registrations survive an array override, since narrowing the OS list is not a request to start importing a library's sidecars. |
| — (plugin) | — | object | — | `sources({ styles: { folder: 'styles', extensions: ['css'] } })` registers build inputs as catalog entities, one collection per key. A sidecar can then read them with `findEntities()`, whose queries land in the render's `refClosure` — so editing, adding or removing a part re-renders the bundle and nothing else. Reading the same files with `fs` instead works for one build and silently breaks watch, because the engine has no dependency on a file it never saw. Nothing is linked into `outputFolder`: these are inputs, not output. Named `sources` rather than `inputs` because `entity.inputs` already means something adjacent — bytes an output depends on without being entities at all. |
| `cors` / `no-cors` | `--cors` / `--no-cors` | boolean | — | Toggle CORS on the engine's shared Express app. See `src/server.js` for the extensible header arrays plugins push onto. |
| `server.requestTimeout` | — | number | node default (`300000`) | Milliseconds a single request may take, set on the underlying `http.Server`. Node's 5-minute default is effectively an **upload size limit expressed in seconds** — a large file over a slow link is indistinguishable from a stalled request, so it is cut off and the caller sees a truncated write rather than a readable error. Raised to two hours automatically when any route registers as `streaming` (an upload surface such as `mikser-io-drive`), because Node's default mismeasures exactly those; set this explicitly to override. `0` disables the cap: reasonable on a trusted-network build server, bad facing the internet, where it removes the only bound on how long a client can hold a connection open doing nothing. `headersTimeout` is clamped to stay at or below it. The server is also exposed as `runtime.options.httpServer`. |
| `url` | `-u, --url <url>` | string | — | Public URL where this mikser is reachable (e.g. `https://blog.me.com`). Validated, trailing slash stripped, stamped on `runtime.options.url`. Read by webhook-capable plugins for push-vs-poll gating (`url.startsWith('https://')`); used by anything that surfaces absolute URLs externally — MCP preview URLs returned to agents, forms share links, email tracking pixels. Plugins that just need internal URLs keep using `runtime.options.port`. |

### `siteRoots`

Which subtrees of the output folder are deployed as their own domain root.

```js
export default {
    // out/bg, out/en and out/mk each deploy to their own domain
    siteRoots: ['bg', 'en', 'mk'],
}
```

Read by the url helpers and by the broken-reference check.

**It changes the output.** `asset`, `href` and `resource` build a path from the
page to the target, and without this they measure from the output folder. When
`out/bg` is what gets deployed, that is one directory too far — every url
carries an extra `..` for the site segment. A browser floors a climb above the
origin root rather than failing, so those urls load and nothing reports them.
Declaring the roots makes the helpers measure from the site instead, and the
urls become what they should have been.

The check reads it for the same reason, and resolves urls the way a browser
does. Where the site root is decides whether `../../x.svg` on a given page is
correct, merely over-deep, or broken.

Default is the output folder itself, which is right for the ordinary case of
one site per build — and with nothing declared every url is byte-identical to
what it was. Only a build that emits several sites moves, and it moves from
working-by-flooring to correct.

Declaring it also asserts something: **a site root is a deployable unit.** It
is served alone, so anything its pages reference has to exist beneath it —
share a common assets folder into each root rather than beside them. A url to
a target in a *different* root is left as it was, because on a per-domain
deploy no relative path reaches another origin; the check will report it, which
is the honest answer.

Nothing can infer any of this: it is a fact about where the bytes get deployed,
not about the bytes.

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

Runs shell commands at lifecycle hooks. A plugin, so it goes in `plugins` and
takes its options as factory arguments:

```js
import { commands } from 'mikser-io'

export default {
  plugins: [
    commands({
      load: 'echo Loading...',
      finalized: ['npm run compress', 'npm run deploy'],
      // Also an async function, resolved when the hook fires
      processed: async () => process.env.NODE_ENV === 'production' && 'npm run optimize',
    }),
  ],
}
```

Hook names: `load`, `loaded`, `import`, `imported`, `process`, `processed`,
`persist`, `persisted`, `beforeRender`, `render`, `afterRender`, `cancel`,
`cancelled`, `finalize`, `finalized`.

#### From the command line

One flag names a hook, so a one-off side effect needs no config edit:

```bash
mikser --command finalized="node deploy/publish.mjs"

# repeatable
mikser --command loaded="node probe.mjs" --command finalized="node publish.mjs"
```

The same shape as `--tool <name>`: one word of CLI namespace for an
open-ended set, rather than one flag per hook. It runs *in addition to*
whatever the config declares for that hook, and only for that run. Forwarded
to a running `--watch` instance it **replaces** the previous request's
commands rather than adding to them, and the instance's own rebuilds run
none — one hook is registered at load and reads a value the instance swaps
per request. The flag exists only when `commands()` is in the config, like
every plugin option, and an unknown hook name is refused before anything is
built.

#### Installing on a running instance

`--command` spends itself on one build. A watcher's **own** rebuilds — the
ones a file save triggers, which is the point of watching — run nothing, so a
probe fires only when you forward a build by hand. `--command-install` puts it
on the instance instead:

```bash
mikser --command-install finalized="node probe.mjs"   # installs, and runs now
# ...edit a file, the watcher rebuilds  → probe runs
# ...edit again                         → probe runs
mikser --command-reset                                # clears all of them
mikser --command-reset finalized                      # or just one hook
```

Installed commands are announced on **every** cycle, not once — you may have
set one an hour ago, and each build's report has to carry the fact that it was
not a function of the repository alone. Per-request commands are announced
once per process, because they are in the invocation you just typed.

On a one-shot build there is no instance to install on, so `--command-install`
runs once and exits with the process exactly like `--command` — reported under
`command-install-without-instance` rather than left to look persistent.

To see what is attached, read the last build: every installed command is
announced on **every** cycle under `command-from-cli`, so the log or the
`--json` report names each one. There is deliberately no `--tool commands` —
the tool registry is mirrored into MCP over HTTP with an allow-all default,
and a command string routinely carries a path, a host or a token. Listing
them there would hand an authenticated web client a map of the build box, and
tools have no per-tool scope to gate it with.

Two hooks behave differently from the rest, and both say so rather than
failing quietly:

- **`load` is refused.** Options are declared *during* the load phase and the
  table is parsed after it, so a `--command load=` could never fire. It is
  named and refused rather than left out of the list, because "no hook named
  load" would be untrue and would send you looking for a typo. Declare it in
  the config instead.
- **`loaded` does not fire for a forwarded build.** A running instance loaded
  at startup and a rebuild does not repeat the load phase, so a load-phase
  hook belongs to the instance rather than to the request. Asking for one
  warns under `command-hook-not-reached`. Stop the instance, or use a
  per-cycle hook.

Two hooks behave differently from the rest, and both say so rather than
failing quietly:

- **`load` is refused.** Options are declared *during* the load phase and the
  table is parsed after it, so a `--command load=` could never fire. Declare
  it in the config instead.
- **`loaded` does not fire for a forwarded build.** A running instance loaded
  at startup and a rebuild does not repeat the load phase, so a load-phase
  hook belongs to the instance rather than to the request. Asking for one
  warns under `command-hook-not-reached`. Stop the instance, or use a
  per-cycle hook.

Two things to know, and they are the reason this is a flag rather than a
convenience:

**It is reported, under `command-from-cli`.** A build is otherwise a function
of the repository — same commit, same bytes, and `--fingerprint` can prove it.
A command from argv makes it a function of the repo *and* how it was invoked,
so an agent, a person and CI can all run "the same build" and get different
output. The warning carries the hook and the command string into `--json`
`warnings`, so a fingerprint taken from that build stays interpretable instead
of quietly meaning something else.

**A command that writes into the output folder fails `--audit-output`.** Not a
limitation to work around — mikser hashes each file as it writes it, so
rewriting one afterwards is indistinguishable from tampering, and the audit
reports it as `Mismatched` and exits 2. Post-build minification through a hook
is therefore the wrong shape; it belongs in a renderer or a postprocessor,
where the hash is taken over what is actually deployed. The honest use for
hooks is side effects that do not touch `out/` — publishing, notifying,
syncing — which is also the case where a flag beats config, because deploy
steps are environment-specific and do not belong in a repository's build
config.

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
