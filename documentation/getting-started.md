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
export default {
  plugins: ['documents', 'layouts'],

  documents: {
    documentsFolder: 'content'
  },

  layouts: {
    layoutsFolder: 'layouts',
    autoLayouts: true,
    cleanUrls: true
  }
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
  -d, --debug                      Show debug log statements
  -t, --trace                      Show trace log statements
  -e, --runtime-folder <folder>    Runtime/temp folder (default: runtime)
```

## Using Mikser Programmatically

```js
import { setup } from 'mikser-io'

const runtime = await setup({
  workingFolder: './my-project',
  plugins: ['documents', 'layouts'],
  outputFolder: 'dist',
  mode: 'production'
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
  setup,
  runtime,
  findEntities,
  useRenderer,
  useCollection,
} from 'mikser-io'

await setup({
  workingFolder: './content',
  plugins: ['documents', 'front-matter', 'yaml', 'layouts',
            'render-hbs', 'post-pdf'],
})
await runtime.start()

const { render } = useRenderer(runtime)
const documents = useCollection(runtime, 'documents')

// 1) Render an entity on demand. Concurrent calls coalesce into the
//    same process() cycle; the worker pool renders the batch in parallel.
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
├── catalog.json        # Entity catalog snapshot
├── journal.db          # SQLite journal (temporary)
└── render-details.json # Render results
```

## Watch Mode

```bash
mikser --watch
```

In watch mode Mikser watches all source folders. When a file changes, it runs only the process → render → finalize cycle (not the full import), making incremental rebuilds fast.

## Next Steps

- [Configuration Reference](./configuration.md) — all config options in detail
- [Plugins](./plugins.md) — available plugins and how to write your own
- [Lifecycle](./lifecycle.md) — understand the processing phases
- [Rendering](./rendering.md) — how templates and renderers work
