// What a handlebars template DEPENDS ON, which is the raw material for the
// layout contract that mikser_layouts_inspect reports.
//
// Two things used to be dropped, and both broke the contract at exactly the
// point it becomes useful — the boundary between one file and the next:
//
//   - the ARGUMENTS a partial is called with. `{{> ui/tags tags=hero.tags}}`
//     makes this template depend on `hero.tags`, and recording only the
//     partial's NAME meant a key consumed one file down was invisible.
//   - block params. `{{#with document.meta.hero as |hero|}}` renames a path,
//     and reporting the local name `hero.title` names a key that appears in
//     no document and that no author can write.
//
// Scope is resolved HERE because this is the only place it is known: the
// closure walker downstream sees paths, not blocks.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseReferences } from '../../../src/plugins/render/hbs.js'

const argsOf = (r, name) => r.partials.find(p => p.name === name)?.args ?? null

describe('hbs parseReferences: partial arguments', () => {
    it('records the arguments a partial is called with', () => {
        const r = parseReferences('{{> ui/tags tags=document.meta.hero.tags rows=document.meta.hero.tagRows}}')
        assert.deepEqual(argsOf(r, 'ui/tags'), {
            tags: 'document.meta.hero.tags',
            rows: 'document.meta.hero.tagRows',
        })
    })

    it('counts them as references of the CALLING template', () => {
        // The path is resolved in this scope, before the partial ever runs.
        const r = parseReferences('{{> ui/btn label=document.meta.cta}}')
        assert.ok(r.variables.includes('document.meta.cta'))
    })

    it('ignores literal arguments, which depend on nothing', () => {
        const r = parseReferences('{{> ui/btn variant="secondary" label=document.meta.cta}}')
        assert.deepEqual(argsOf(r, 'ui/btn'), { label: 'document.meta.cta' })
    })

    it('merges call sites, so one partial is one entry', () => {
        const r = parseReferences('{{> ui/btn label=a.one}}{{> ui/btn href=a.two}}')
        assert.equal(r.partials.length, 1)
        assert.deepEqual(argsOf(r, 'ui/btn'), { label: 'a.one', href: 'a.two' })
    })

    it('records a positional context as an alias, since it rebinds the root', () => {
        const r = parseReferences('{{> ui/card document.meta.hero}}')
        assert.deepEqual(r.partials.find(p => p.name === 'ui/card').aliases,
            [{ from: 'document.meta.hero', to: null }])
    })
})

describe('hbs parseReferences: block params', () => {
    it('resolves a with-alias back to the path it renames', () => {
        const r = parseReferences('{{#with document.meta.hero as |hero|}}{{hero.title}}{{/with}}')
        assert.ok(r.variables.includes('document.meta.hero.title'),
            `expected the resolved path, got: ${r.variables.join(', ')}`)
        assert.ok(!r.variables.includes('hero.title'), 'the local name must not survive')
    })

    it('marks an each-item as an ELEMENT, not as the collection', () => {
        // `cases.specs` would be a key that exists on no document — the specs
        // are on each case, not on the list of them.
        const r = parseReferences('{{#each document.meta.cases as |c|}}{{c.specs}}{{/each}}')
        assert.ok(r.variables.includes('document.meta.cases[].specs'))
        assert.ok(!r.variables.includes('document.meta.cases.specs'))
    })

    it('does NOT leak a block param past the end of its block', () => {
        // The alias is scoped to the block. Applying it after would resolve a
        // different `hero` to a path it never had.
        const r = parseReferences('{{#with document.meta.hero as |hero|}}{{hero.a}}{{/with}}{{hero.b}}')
        assert.ok(r.variables.includes('document.meta.hero.a'))
        assert.ok(r.variables.includes('hero.b'), 'outside the block it is a different, unresolved name')
        assert.ok(!r.variables.includes('document.meta.hero.b'))
    })

    it('resolves arguments through the block they are written in', () => {
        const r = parseReferences(
            '{{#each document.meta.cases as |c|}}{{> ui/tag label=c.title}}{{/each}}')
        assert.deepEqual(argsOf(r, 'ui/tag'), { label: 'document.meta.cases[].title' })
    })
})

describe('hbs parseReferences: shape', () => {
    it('returns the same keys as every other engine, so no caller branches', () => {
        for (const source of ['', '{{a}}', '{{#if']) {
            const r = parseReferences(source)
            for (const key of ['variables', 'partials', 'iterations', 'assigns']) {
                assert.ok(key in r, `${JSON.stringify(source)} is missing ${key}`)
            }
        }
    })

    it('reports a parse error rather than throwing', () => {
        const r = parseReferences('{{#if unclosed}}')
        assert.ok(r.parseError, 'the message is the useful part of a broken template')
        assert.deepEqual(r.partials, [])
    })
})
