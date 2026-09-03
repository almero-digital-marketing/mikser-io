// A field no schema declares is not a validation pass.
//
// Zod objects are non-strict by default: an undeclared key is dropped from
// `result.data` and the parse SUCCEEDS. The plugin reads only `result.success`,
// so the entity keeps the key and renders with it — a whole section can exist,
// render, and validate clean while nothing knows its shape.
//
// That is a green that cannot go red, the same shape as the widened `match`
// that matched nothing and the forwarded `--clear` that cleared nothing: the
// check runs, reports success, and the thing it was supposed to check was
// never in its field of view.
//
// Warned, not failed, and outside `fail` mode on purpose: a project already
// carrying undeclared keys should learn about them, not have its build stop on
// the upgrade that added the check. A schema wanting them rejected says
// `.strict()`, which zod reports itself.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const config = (extra = '') => `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { schemas } from 'mikser-io-schemas'
export default { plugins: [documents(), frontMatter(), yaml(), layouts(), renderHbs(),
    schemas({ schemaKey: 'meta.layout'${extra} })] }
`
const schema = (body) => `import { z } from 'zod'\nexport default ${body}\n`
const OPEN = schema("z.object({ layout: z.string(), title: z.string() })")

describe('a document field the schema never declared', () => {
    const workdir = freshWorkdir('schema-undeclared')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': config(),
            'schemas/page.js': OPEN,
            'layouts/page.html.hbs': '<!doctype html><body>{{document.meta.title}}</body>',
            'documents/a.yml': 'layout: page\ntitle: One\ndevices:\n  - name: hera\n',
        })
    })

    const run = (args = []) => runMikser(workdir, ['--force', ...args])

    it('says so, instead of passing', async () => {
        const { code, combined } = await run()
        assert.equal(code, 0, `a warning, not a failure\n${combined}`)
        assert.match(combined, /\[schema-undeclared-key\]/, combined)
        assert.match(combined, /does not declare: devices/, combined)
    })

    it('explains why it validated clean, which is the confusing part', async () => {
        const { combined } = await run()
        assert.match(combined, /Zod drops what it does not know about/, combined)
        assert.match(combined, /\.strict\(\)/, 'and how to make it an error')
    })

    it('does not flag the keys the engine stamps', async () => {
        // href/lang/layout/url/cache are put there by the engine and declared
        // by nobody. Flagging them is the noise that gets the real line
        // filtered out — so the exclusion is derived from the catalog's own
        // meta_ columns rather than written down and left to go stale.
        await writeFile(path.join(workdir, 'documents/a.yml'),
            'layout: page\ntitle: One\nhref: /a\nlang: en\n')
        const { combined } = await run()
        assert.doesNotMatch(combined, /schema-undeclared-key/, combined)
    })

    it('goes quiet once the field is declared', async () => {
        await writeFile(path.join(workdir, 'documents/a.yml'),
            'layout: page\ntitle: One\ndevices:\n  - name: hera\n')
        await writeFile(path.join(workdir, 'schemas/page.js'),
            schema("z.object({ layout: z.string(), title: z.string(), "
                + "devices: z.array(z.object({ name: z.string() })) })"))
        const { code, combined } = await run()
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /schema-undeclared-key/, combined)
    })

    it('leaves a .strict() schema to zod, without reporting twice', async () => {
        // strict already fails the parse with unrecognized_keys, so this never
        // reaches the success path. Two messages for one mistake is the thing
        // the code-on-the-console work was about.
        await writeFile(path.join(workdir, 'schemas/page.js'),
            schema("z.object({ layout: z.string(), title: z.string() }).strict()"))
        const { combined } = await run()
        assert.match(combined, /schema\(page\)/, `strict must still report\n${combined}`)
        assert.doesNotMatch(combined, /schema-undeclared-key/, combined)
    })

    it('respects onError: off, like every other schema message', async () => {
        await writeFile(path.join(workdir, 'schemas/page.js'), OPEN)
        await writeFile(path.join(workdir, 'mikser.config.js'), config(", onError: 'off'"))
        const { combined } = await run()
        assert.doesNotMatch(combined, /schema-undeclared-key/, combined)
    })
})
