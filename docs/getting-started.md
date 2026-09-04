# Getting Started

## Prerequisites

- Node.js 18 or later
- A project with `"type": "module"` in `package.json` (Mikser is ESM-only)

## Installation

### As a project dependency

```bash
npm install mikser-io
```

### As a global CLI

```bash
npm install -g mikser-io
mikser
```

## Your First Project

### 1. Project structure

```
my-site/
├── content/          # Source documents
│   ├── index.md
│   └── about.md
├── layouts/          # HTML templates
│   └── page.hbs
├── mikser.config.js
└── package.json
```

### 2. Configuration file

Create `mikser.config.js` in the root of your project:

```js
// mikser.config.js
import { documents, layouts } from 'mikser-io'

export default {
  plugins: [
    documents({ documentsFolder: 'content' }),
    layouts({
      layoutsFolder: 'layouts',
      autoLayouts: true,
      cleanUrls: true,
    }),
  ],
}
```

### 3. A document

```markdown
---
title: Home
description: Welcome to my site
---

# Hello World

This is the homepage.
```

Front matter (YAML between `---`) is extracted into `entity.meta`. The remaining content is in `entity.content`.

### 4. A layout template

Layouts are Handlebars templates:

```handlebars
{{! layouts/page.hbs }}
<!DOCTYPE html>
<html>
<head>
  <title>{{document.meta.title}}</title>
</head>
<body>
  {{{document.content}}}
</body>
</html>
```

### 5. Run

```bash
npx mikser
# or
node node_modules/.bin/mikser
```

Output will be written to the `out/` folder.

## CLI Options

```
mikser [options]

  -i, --working-folder <folder>    Working folder (default: ./)
  -p, --plugins [plugins...]       Plugins to load
  -c, --config <file>              Config file path (default: ./mikser.config.js)
  -m, --mode <mode>                Runtime mode (default: development)
  -r, --clear                      Clear output before run
  -o, --output-folder <folder>     Output folder (default: out)
  -w, --watch                      Watch for file changes
  -f, --force                      Rebuild everything; disable incremental dispatch
  -R, --resume                     Continue from journal entries left by a previous
                                   interrupted run; skip the initial filesystem scan
      --audit-output                     Audit output against recorded snapshots; report
                                   drift instead of building
  -l, --log <level>                Log level for this run: trace, debug, info,
                                   notice, warn, error, fatal, silent
  --log-install <level>            Set the level on a RUNNING instance, so its
                                   own rebuilds are verbose too. Expires.
  --log-reset                      Return an instance to its configured level
  -e, --runtime-folder <folder>    Runtime/temp folder (default: runtime)
```

`--resume` is the flag for picking up where an interrupted run left off — PM2 auto-restart, CI checkpoint, anything that killed mikser mid-cycle. Without `--resume`, leftover journal entries from the prior run are discarded at startup with a warning. Pair `--resume` with `--watch` to also catch filesystem changes that happened after the restart.

## Using Mikser Programmatically

```js
import { setup, documents, layouts } from 'mikser-io'

const runtime = await setup({
  workingFolder: './my-project',
  plugins: [documents(), layouts()],
  outputFolder: 'dist',
  mode: 'production',
})

await runtime.start()
```

Any option passed to `setup()` overrides CLI arguments and config file values.

## Programmatic API with Custom Hooks

```js
import { setup, onFinalized, useLogger } from 'mikser-io'

onFinalized(async () => {
  const logger = useLogger()
  logger.info('Build complete — deploying...')
  // deploy logic
})

const runtime = await setup({ clear: true })
await runtime.start()
```

## On-demand Rendering (library use)

When you embed mikser inside another Node.js service — say, generating
PDFs on request — use the same primitives the API plugin uses, without
needing the API plugin itself:

```js
import {
  setup, runtime, findEntities, useRenderer, useCollection,
  documents, frontMatter, yaml, layouts, renderHbs,
} from 'mikser-io'
import { postPdf } from 'mikser-io-post-pdf'

await setup({
  workingFolder: './content',
  plugins: [
    documents(), frontMatter(), yaml(), layouts(),
    renderHbs(), postPdf(),
  ],
})
await runtime.start()

const { render } = useRenderer(runtime)
const documents = useCollection(runtime, 'documents')

// 1) Render an entity on demand. Concurrent calls coalesce into the
//    same process() cycle; the worker pool renders the batch in parallel.
//    By default the entity stays in the catalog after the render —
//    that's what mikser's normal lifecycle does (anything persisted is
//    queryable via findEntities). For on-demand renders where the
//    bytes are the work product and you don't want the metadata row to
//    accumulate, pass { catalog: false } to opt out. The rendered
//    output file is kept on disk either way.
const { output, entity } = await render({
  id: '/documents/en/report.md',
  type: 'document',
  collection: 'documents',
  format: 'md',
  meta: { layout: 'report' },
  content: '# Quarterly report ...',
})
// output.result is a Buffer for PDF, a string for HTML, etc.
// entity.destination tells you what extension was produced.

// 2) Write or remove content in a watched collection folder.
//    In watch mode, this triggers the normal sync → process cycle.
await documents.write('en/draft.md', '# Draft')
await documents.remove('en/old.md')

// 3) Query the catalog (already public; just here for completeness).
const docs = await findEntities({ collection: 'documents' })
```

`useRenderer(runtime)` binds to the runtime and returns `{ render }`,
where `render(entity, opts?)` resolves with `{ output, entity }`.
Concurrent calls coalesce into the same `process()` cycle automatically;
parallelism within the cycle is governed by `runtime.options.threads`.

`render` options:

- `timeout` — per-call timeout in ms (default 30_000).
- `catalog` (default `true`) — keep the entity in the catalog after the
  render. Pass `catalog: false` to prune the row, useful for on-demand
  renders where the metadata would just accumulate.
- `save` (default `true`) — write the rendered output to disk at
  `<outputFolder>/<entity.destination>`. Pass `save: false` to skip the
  final disk write; the bytes still come back in `output.result` for you
  to pipe directly to an HTTP response, S3, an email service, etc. For
  layouts that have a postprocessor (e.g. `*.html-pdf.*`), the
  *intermediate* file is still written so the postprocessor can read it
  — only the final output is affected.

Both flags use strict equality. Only the literal `false` opts out;
ambiguous inputs (`null`, `"false"`, `0`, missing) fall through to the
default. This avoids surprises from stringly-typed JSON bodies.

When the API plugin is mounted, the body shape mirrors the JS API:
entity fields at the top level, control flags grouped under `options`.
Example — a service that returns a PDF to the caller and doesn't want
either the catalog row or the disk file:

```http
POST /api/render
Content-Type: application/json

{
  "id": "/docs/invoice.md",
  "collection": "documents",
  "type": "document",
  "meta": { "layout": "invoice" },
  "content": "...",
  "options": { "catalog": false, "save": false }
}
```

Anything not under `options` is passed through as the entity; the
`options` key never leaks onto the entity object.

`useCollection(runtime, name)` binds to a single collection's source
folder and returns `{ name, folder, write, remove }` for filesystem-level
operations against it.

## Output Structure

After a successful run:

```
out/
├── index.html          # Rendered pages
├── about/
│   └── index.html      # Clean URLs produce folders
runtime/
└── mikser.sqlite       # Engine database — catalog, refs, render
                        # snapshots (mikser_entities, mikser_refs,
                        # mikser_snapshots tables). See ADR-0009.
```

## Watch Mode

```bash
mikser --watch
```

In watch mode Mikser watches all source folders. When a file changes, it runs only the process → render → finalize cycle (not the full import), making incremental rebuilds fast.

For long-running watch processes managed by PM2 / systemd / a container restart loop, add `--resume`:

```bash
mikser --watch --resume
```

A restart picks up any journal entries the prior run didn't finalize and resumes from there, skipping the initial filesystem scan. The chokidar watcher still attaches, so any source change between the kill and the restart flows through normally.

## Next Steps

- [Configuration Reference](./configuration.md) — all config options in detail
- [Plugins](./plugins.md) — available plugins and how to write your own
- [Lifecycle](./lifecycle.md) — understand the processing phases
- [Rendering](./rendering.md) — how templates and renderers work
