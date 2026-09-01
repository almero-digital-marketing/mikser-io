# Rendering

The render system executes template processing and asset transformation. It supports three execution modes and a layered plugin system that loads capabilities on demand per entity.

## How Rendering Works

Rendering is triggered by RENDER operations in the journal. Each entry describes one job: an entity, a renderer name, options, and context data.

```
RENDER journal entries
        │
        ▼
   onRender hook (engine.js)
        │
        ├── For each unique entity:destination pair
        │
        ▼
   render(renderOptions)    ← src/render.js
        │
        ├── Load context plugins    (context.plugins[])
        ├── Load renderer plugin   (render-{options.renderer})
        ├── Load entity plugins    (entity.meta.plugins[])
        ├── Load options plugins   (options.plugins[])
        │
        ├── Call plugin.load() on each plugin
        │
        └── Call renderer.render()
              └── Returns rendered content
```

## Execution Modes

Controlled by `options.tasks`:

| Mode | Constant | Description |
|------|----------|-------------|
| Inline | `TASKS.INLINE` | Runs in the main event loop via `await`. The outer dispatcher iterates with concurrency = `runtime.options.threads`. Right default for cheap renders (HTML / md / yaml templating) where IPC overhead would dominate. |
| Serial | `TASKS.SERIAL` | Runs in the main event loop too, but via p-queue with concurrency 1. One at a time, no interleaving. Right choice for tasks that touch a shared, non-reentrant resource. |
| Worker | `TASKS.WORKER` | Runs on a real OS thread via the Piscina pool sized to `runtime.options.threads`. True parallelism. Right choice for expensive CPU-bound renders (PDF, MJML, image compose). The pool is lazy (`minThreads: 0`), so INLINE-only workloads pay no worker overhead. |

Set per-entity in frontmatter:

```yaml
---
task: worker
---
```

Both the render and the postprocess for that entity then route through the Piscina pool. Or set programmatically:

```js
await renderEntity(entity, { renderer: 'hbs', tasks: 'INLINE' })
await renderEntity(entity, { renderer: 'preset', tasks: 'WORKER' })
```

## Inline Concurrency

The number of parallel renders (inline mode) is controlled by `options.threads` (default: 4):

```js
const runtime = await setup({ threads: 8 })
```

## The Render Function

```js
// src/render.js — exported for both direct calls and worker execution
render({
  entity,     // The entity being rendered
  options,    // { renderer, tasks, plugins, ...runtimeOptions }
  config,     // Render-prefixed config keys (render-hbs, render-preset, etc.)
  context,    // Layout context (data, plugins)
  state,      // runtime.state snapshot
  logger,     // Logger instance
  port        // MessagePort (worker mode only)
})
```

The `config` object passed to a renderer's `load` / `render` is the same `options` the consumer passed at the factory call site. Renderer-specific config is set inline:

```js
// mikser.config.js
import { renderHbs } from 'mikser-io'

export default {
  plugins: [
    renderHbs({
      helpers: ['./helpers/custom.js'],
    }),
    // ...
  ],
}
```

The renderer's factory stashes the options on the descriptor; the dispatcher passes them through as the `config` arg to `load` and `render` (ADR-0010).

## The Runtime Object in Templates

Inside a render, a `runtime` object is assembled and passed to all plugins:

```js
{
  [entity.type]: entity,   // e.g. runtime.document = entity
  entity,                  // same reference
  plugins,                 // loaded plugin instances keyed by name
  config,                  // render config
  data: context.data,      // context data from layout's load()
  content(),               // async function: reads entity.source as UTF-8
  log, warn, error,        // logger functions — see "Logging from templates"
  debug, trace
}
```

Render plugins extend this object further (e.g. `runtime.href`, `runtime.asset`, `runtime.resource`).

`asset(preset, url)` returns the deployed URL of a preset derivative, relative
to the page asking for it:

```hbs
<img src="{{ (asset 'web' '/media/hero.jpg').url }}">
```

The extension comes from the preset — every preset module exports a `format`,
and the helper uses it, so a template never has to repeat it. Pass a third
argument to override it, and mikser warns if that contradicts what the preset
actually produces.

It BUILDS the url rather than looking one up, which is worth knowing: nothing
it returns has been checked against a file. A preset name nothing declares
warns once, but a derivative that simply was not generated cannot be detected
here. Where you have the entity rather than a path, `meta.presets` is the
looked-up answer (ADR-0011).

### Logging from templates

The runtime exposes five logger functions — `log` (info), `warn`, `error`, `debug`, `trace` — that route through Mikser's central logger (`useLogger()` is resolved at call time, so progress-bar wrappers in `info` mode are honoured). Each renderer's auto-helper loop picks them up:

```hbs
{{!-- Handlebars --}}
{{log "📄 Rendering page" document.id}}
{{warn "Missing meta.author"}}
```

```liquid
{# Liquid — message on the left, extra context after the colon #}
{{ "📄 Rendering page" | log: document.id }}
```

```eta
<%# Eta — regular JS call %>
<% log("📄 Rendering page", document.id) %>
```

Args are flattened into a single space-separated message (objects are `JSON.stringify`-ed). Handlebars' internal options object is stripped automatically. This means **the first argument is always the message** — putting `document.id` first in a Liquid pipe would log just the id and discard the label.

## Plugin Load / Render Protocol

Each render plugin can export two functions:

```js
export async function load({ entity, options, config, context, runtime, state, logger }) {
  // Runs once per render job
  // Extend runtime with helpers, load external data, register partials, etc.
  runtime.myHelper = (arg) => `result: ${arg}`
}

export async function render({ entity, options, config, context, plugins, runtime, state, logger }) {
  // The actual rendering logic
  // Return the rendered content as a string, or a file path
  const template = await runtime.content()
  return myTemplateEngine(template, runtime)
}
```

Only the renderer plugin (named `render-{options.renderer}`) is expected to export `render()`. Other plugins (loaded via `context.plugins`, `entity.meta.plugins`, `options.plugins`) typically only export `load()`.

---

## Renderer Plugins

### `render-hbs` — Handlebars

The primary template renderer. Compiles and executes a Handlebars template.

**Config key:** `render-hbs`

**Usage:**

```js
await renderEntity(entity, { renderer: 'hbs' }, context)
```

**Template context:**

All properties of the `runtime` object are available directly in the template:

```handlebars
{{! layouts/page.hbs }}
<!DOCTYPE html>
<html lang="en">
<head>
  <title>{{document.meta.title}}</title>
  <link rel="stylesheet" href="{{url (href '/styles/base.css')}}">
</head>
<body>
  <main>
    {{{document.content}}}
  </main>
  <nav>
    <a href="{{url (href '/')}}">Home</a>
    <a href="{{url (href '/about')}}">About</a>
  </nav>
</body>
</html>
```

**Available variables in templates:**
- `document` (or the entity type) — the entity being rendered
- `entity` — same
- `plugins` — loaded plugin instances
- `config` — render config
- `data` — context data from layout's load()
- All helpers registered by render plugins

**Handlebars helpers included:**

Mikser ships with [@budibase/handlebars-helpers](https://www.npmjs.com/package/@budibase/handlebars-helpers) (a maintained fork of `handlebars-helpers`), providing:

| Category | Helpers |
|----------|---------|
| Arrays | `after`, `before`, `filter`, `first`, `last`, `map`, `sort`, `unique`, ... |
| Collections | `isEmpty`, `iterate`, ... |
| Comparisons | `eq`, `ne`, `lt`, `gt`, `and`, `or`, `if`, ... |
| Math | `add`, `subtract`, `multiply`, `divide`, `ceil`, `floor`, `round`, ... |
| Strings | `lowercase`, `uppercase`, `trim`, `truncate`, `replace`, `startsWith`, ... |
| URLs | `encodeURI`, `decodeURI`, ... |

Plus two helpers registered directly by `render-hbs`:

| Helper | Source | Usage |
|---|---|---|
| `date` | [dayjs](https://www.npmjs.com/package/dayjs) | `{{date created "YYYY-MM-DD"}}` — format defaults to `YYYY-MM-DD` |
| `url` | built-in | `{{url}}` (current context) or `{{url someObj}}` |

`markdown` and `removeMarkdown` are not included by default. Add the [`mikser-io-render-markdown`](https://www.npmjs.com/package/mikser-io-render-markdown) plugin: `import { renderMarkdown } from 'mikser-io-render-markdown'` and add `renderMarkdown()` to your plugins list. Its runtime functions become Handlebars helpers automatically: `{{{markdown meta.body}}}`, `{{removeMarkdown meta.body}}`.

**Partials:** Any layout with a name starting with `partials` and `format: 'hbs'` is automatically registered as a Handlebars partial:
```
layouts/
└── partials/
    ├── header.hbs   → {{> partials/header}}
    └── footer.hbs   → {{> partials/footer}}
```

---

### `render-preset` — Asset Presets

Runs an asset transformation preset (e.g. image resizing, conversion).

**Usage:**

```js
// Typically queued by the assets plugin automatically
await renderEntity(entity, { renderer: 'preset', tasks: 'WORKER' })
```

The entity must have `entity.preset` set (done by the assets plugin). The preset module is loaded and its default export is called with the full render context.

---

### External Renderers

Additional template engines are available as installable packages — drop the package name into `plugins` (without the `mikser-io-` prefix) and set `renderer: '<name>'`:

| Package | Renderer | Notes |
|---|---|---|
| [`mikser-io-render-eta`](https://www.npmjs.com/package/mikser-io-render-eta) | `eta` | Fast embedded JS templates. `cache` defaults to `!options.watch`. |
| [`mikser-io-render-ect`](https://www.npmjs.com/package/mikser-io-render-ect) | `ect` | Lightweight ECT templates. |
| [`mikser-io-render-markdown`](https://www.npmjs.com/package/mikser-io-render-markdown) | (helper) | Adds `markdown`/`removeMarkdown` to the render runtime (and as Handlebars helpers). |
| [`mikser-io-render-metatext`](https://www.npmjs.com/package/mikser-io-render-metatext) | (helper) | Adds `metatext`/`removeMetatext` bracket-to-HTML helpers. |

---

## Helper Render Plugins

These plugins extend the `runtime` object inside templates. They are loaded automatically when the `render-hbs` renderer is used, or can be listed in `context.plugins`.

### `render-href` — Link Resolution

Resolves internal links via `runtime.lookupHref(path)` — a sync function backed by the `meta_href` index on `mikser_entities` — and computes relative URLs from the current document's output location.

**Functions added to `runtime`:**

#### `href(path, lang?)`

Looks up an entity by its virtual path. Returns an object with the entity's metadata and a `url` property containing the relative URL from the current document's output location.

When the path resolves to nothing in the catalog (e.g. a static file like a CSS or PDF), `href` still returns `{ url }` computed as a relative path — so it works for any output file, not just rendered entities.

```handlebars
{{! Look up an entity — returns { url, meta, ... } }}
{{#with (href '/blog/getting-started')}}
  <a href="{{url}}">{{meta.title}}</a>
  <p>{{meta.description}}</p>
  <span>{{date meta.date 'MMMM D, YYYY'}}</span>
{{/with}}

{{! Inline link — wrap with url helper to extract .url }}
<a href="{{url (href '/blog/getting-started')}}">Blog</a>

{{! CSS and static files — also resolved as relative URLs }}
<link rel="stylesheet" href="{{url (href '/styles/base.css')}}">

{{! Resolve with language override }}
<a href="{{url (href '/blog/post' 'fr')}}">FR</a>

{{! Pagination links }}
{{#if prev}}
  <a href="{{url (href document.name prev)}}">Previous</a>
{{/if}}
{{#if next}}
  <a href="{{url (href document.name next)}}">Next</a>
{{/if}}
```

#### `hrefLang(path)`

Returns all language variants of a path, as `{ [lang]: entity }`. Useful for building language switchers. Backed by the same `meta_href` index — all matching rows for the path, partitioned by their `meta.lang`.

```handlebars
{{#each (hrefLang document.meta.href)}}
  {{#unless (eq @key ../document.meta.lang)}}
    <li><a href="{{url (href ../document.meta.href @key)}}">{{uppercase @key}}</a></li>
  {{/unless}}
{{/each}}
```

#### `url` helper

Extracts the `.url` property from the object returned by `href`, `resource`, or `asset`. Use it whenever you pass one of these helpers as an attribute value.

```handlebars
{{! Extract url from href result }}
<a href="{{url (href '/blog')}}">Blog</a>

{{! Extract url from asset result }}
<img src="{{url (asset 'thumbnail' name 'webp')}}" />

{{! Extract url from resource result }}
<link rel="stylesheet" href="{{url (resource 'https://cdn.example.com/lib.css')}}">

{{! Inside {{#with (href '...')}} — call url with no args to read from context }}
{{#with (href '/blog/getting-started')}}
  <a href="{{url}}">{{meta.title}}</a>
{{/with}}
```

The `href` plugin calls `runtime.lookupHref(path)` to resolve paths to entities — the same primitive INLINE renders and Piscina workers use. Worker contexts get the same sync API because each worker opens its own read-only sqlite handle on first task. The plugin understands clean URLs and pagination.

---

### `render-asset` — Asset Paths

Generates relative URLs to transformed assets (output of the assets plugin). Returns `{ url }` — use the `url` helper to extract it.

```handlebars
{{! Generate relative URL to transformed asset }}
<img src="{{url (asset 'thumbnail' '/images/photo.jpg')}}" alt="Photo">
<img src="{{url (asset 'thumbnail' '/images/photo.jpg' 'webp')}}" alt="Photo">

{{! Using a name from a resource }}
<img src="{{url (asset 'small-image' (get 'name' (resource document.meta.image)) 'webp')}}" alt="Photo">
```

The underlying path is: `/{assetsFolder}/{preset}/{path}[.{format}]`

---

### `render-resource` — CDN Resource Mapping

Maps CDN URLs to locally cached paths (from the resources plugin). Returns `{ url, name }` — use the `url` helper to extract the relative URL, or `name` to get the filename for further processing (e.g. passing to `asset`).

```handlebars
{{! Map CDN URL to local relative path }}
<link rel="stylesheet" href="{{url (resource 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css')}}">

{{! Use name to pass the cached file into an asset preset }}
<img src="{{url (asset 'small-image' (get 'name' (resource document.meta.image)) 'webp')}}" alt="Photo">
```

---

### `render-file` — File Utilities

Provides file reading helpers for use inside templates.

```handlebars
{{! Read any file as a string }}
{{readFile '/path/to/file.txt'}}

{{! Read and parse a JSON file }}
{{#with (jsonFile './data/config.json')}}
  {{title}}
{{/with}}

{{! Glob for files }}
{{#each (glob '**/*.md' cwd=docsFolder)}}
  {{this}}
{{/each}}
```

---

## Layout's `load()` Function

Layouts (`.js` files alongside `.hbs` templates) can export a `load` function that runs before rendering to provide context data:

```js
// layouts/blog.js  (alongside layouts/blog.hbs)
import { findEntities } from 'mikser-io'

export async function load({ entity, options, config, context, runtime, state, logger }) {
  // Return data to be available as `data` in the template
  return {
    relatedPosts: await findRelated(entity),
    navigation: buildNav(await findEntities({ collection: 'documents', 'meta.layout': { $exists: true } }))
  }
}

// Optionally: specify which plugins to load
export const plugins = ['render-href', 'render-asset']
```

The returned value is available in the template as `data`:

```handlebars
{{#each data.relatedPosts}}
  <a href="{{url (href this.name)}}">{{this.meta.title}}</a>
{{/each}}
```

---

## Pagination

The layouts plugin handles pagination automatically when a layout's `load()` returns a `pages` array:

```js
// layouts/blog-list.js
import { findEntities } from 'mikser-io'

export async function load({ entity, runtime }) {
  const posts = await findEntities({ collection: 'documents', type: 'post' })
  const perPage = 10

  // Return pages array — each item becomes one render job
  return {
    pages: chunk(posts, perPage).map((items, i) => ({
      items,
      page: i + 1,
      total: posts.length
    }))
  }
}
```

For corpus-scale lists where you don't actually need an in-memory array — say, you're piping through a transform that produces one render per entity — use `iterateEntities(query)` instead. It's an async generator over the same sift query shape with internal seek-pagination, so memory stays bounded regardless of how many entities match.

Each item in `pages` triggers a separate render call. The entity gets `entity.page` (1-based index) and `entity.pages` (total count) set. The destination URL includes the page number for pages > 1 (e.g. `/blog/page/2`).

---

## Postprocess

A postprocess stage runs *after* a successful render, transforming the rendered file on disk. MJML → HTML, HTML → PDF, HTML → EML, anything that takes a file and produces a file. Each stage is a `mikser-io-post-<name>` package that returns `{ name, options, postprocess, output?, setup?, teardown? }` from its factory.

### Single-stage opt-in

The `layouts` plugin reads the postprocessor (or chain) from two places:

- **Layout filename** — `<name>.<format>-<post1>[-<post2>...].<template>`. Each segment after the first `-` is a postprocessor name in chain order.
- **Frontmatter** on the source entity — `postprocessor: mjml` or `postprocessors: [mjml]` (dual key, both set is an error).

```
layouts/welcome.html-mjml.hbs        # renderer writes MJML, post-mjml writes HTML
documents/welcome.md                  # plain — opt-in lives on the layout
```

```yaml
# documents/welcome.md — opt-in from the source
---
layout: newsletter
postprocessor: mjml
---
```

### Chains

Filename and frontmatter both accept a *chain*. Stages run in order, threading file paths between them — never buffers; large outputs (PDFs especially) don't sit in memory between stages.

```
layouts/welcome.html-mjml-email.hbs   # renderer → MJML, post-mjml → HTML, post-email → EML
```

```yaml
# Equivalent via frontmatter
---
postprocessors: [mjml, email]
---
```

The final file's extension is the *last* stage's `output:` declaration (`email` → `eml`). Intermediate files land in `runtime/postprocess-scratch/<entity>/<stage-index>-<stage>.<ext>` and are cleaned up after the chain completes (or fails). The renderer's intermediate is also unlinked when the chain's final destination differs from it.

### Stage contract

Each postprocessor's `postprocess()` reads `entity.origin`, writes to `entity.destination`, and returns the path it wrote. Both paths are relative to `options.outputFolder`.

```js
export const output = 'html'    // declares the file extension this stage writes

export async function postprocess({ entity, options, config, logger }) {
  const inAbs  = path.join(options.outputFolder, entity.origin)
  const outAbs = path.join(options.outputFolder, entity.destination)
  const body   = await readFile(inAbs, 'utf8')

  await mkdir(path.dirname(outAbs), { recursive: true })
  await writeFile(outAbs, transform(body))

  return { success: true, result: entity.destination }
}
```

Return shapes the dispatcher accepts:

- `{ success: true, result: '<output-path>' }` — preferred. `result` is the relative-to-outputFolder path the stage wrote.
- `{ success: false, error: '...' }` — fails the chain. Every intermediate (and the final destination, if any) is unlinked.
- `string` — treated as the output path; same as the preferred shape's `result`.
- `Buffer` / bytes — legacy single-stage shape. The engine writes them to `entity.destination` and uses that as the next stage's origin. Useful for cheap transforms; not recommended for large files.

### Failure semantics

A chain is all-or-nothing. The first stage to throw or return `{success: false}` fails the entry; the dispatcher unlinks every intermediate it produced and the final destination, then re-throws. No partial output leaks.

### Execution mode

Postprocess inherits the layout's `task:` setting. `task: worker` routes both render and postprocess through the lazy Piscina pool (right for CPU-heavy stages: PDF, image compose, big MJML compilations). Default INLINE is right for everything else.

---

## Render Output

After rendering completes:

- The rendered content is written to `entity.destination`.
- The journal entry is updated with `output: { success: true, result: '...' }`.
- The render manifest (`mikser_snapshots` table in `runtime/mikser.sqlite`) records the snapshot for the rendered output: `inputHash`, `outputHash`, `refClosure`. On the next cycle `manifest.shouldSkip()` short-circuits renders whose inputs and refs haven't drifted. On DELETE entries (e.g. in watch mode) the corresponding output files are unlinked and the snapshot rows dropped. Paginated children are tracked via `entity.parent` (partial index on the column) so a single source delete sweeps all pages.
- Failed renders are logged and marked `output: { success: false }` but do not abort the run.

### Error output

Render and postprocess errors include a compact source-location suffix so you can jump straight to the layout:

```
Render error: /documents/en/posts/post-1.html [layouts/post.hbs:12] Parse error on line 12: ...
Postprocess error: /documents/en/welcome.yml [layouts/welcome.html-mjml.hbs] MJML: ...
```

The format is `[<relative-layout-path>[:<line>[:<column>]]]`. Each renderer plugin enriches its thrown errors with `layoutUri`, `line`, and `column` when the underlying engine exposes them; the central logger formats whatever is present.

| Renderer | Error info surfaced |
|---|---|
| `render-hbs` | layout path; line extracted from Handlebars' `lineNumber` or "on line N" in message |
| `render-eta` (`mikser-io-render-eta`) | layout path; line extracted from "at line N" in message |
| `render-liquid` (`mikser-io-render-liquid`) | layout path, line, and column from `LiquidError.token` |
