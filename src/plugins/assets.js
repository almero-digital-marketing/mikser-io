import { reportEvaluated } from '../report.js'
import { countEntities } from '../catalog.js'
import path from 'node:path'
import { mkdir, writeFile, unlink, rm, readFile, symlink, } from 'fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { globby } from 'globby'
import _ from 'lodash'
import map from 'p-map'
import { isFullCycle } from '../utils.js'

// Normalize a `options.presets[name]` value to a consistent
// { matches, options } shape so callers don't have to inspect which form
// the config used.
//
// Two formats supported, detected from the value shape:
//
//   // 1. Existing — string or array of match patterns:
//   presets: {
//       'thumbnail': '@/images/*',
//       'small-image': ['/files/images/*.jpg', '/resources/**/*.jpg'],
//   }
//
//   // 2. New — object with `match` and per-preset `options`:
//   presets: {
//       'medium-image': {
//           match: '/files/images/*.jpg',
//           options: { width: 800, height: 600, quality: 80 },
//       },
//   }
//
// Options merge over the preset module's own `options` export at render
// time — module-side defaults, config-side overrides.
//
// Caveat: changing config-side options does NOT automatically invalidate
// already-rendered assets on disk. Bump the preset's `revision` export
// to force a re-render, or run `mikser --clear` to start fresh.
export function normalizePresetConfig(value) {
    if (value == null) return { matches: [], options: {} }
    if (typeof value === 'string') return { matches: [value], options: {} }
    if (Array.isArray(value))      return { matches: value, options: {} }
    if (typeof value === 'object' && ('match' in value || 'options' in value)) {
        const m = value.match
        return {
            matches: Array.isArray(m) ? m : (m == null ? [] : [m]),
            options: value.options ?? {},
        }
    }
    // Fallback — treat the value itself as a single match pattern
    // (object literal with a custom matcher, or a function).
    return { matches: [value], options: {} }
}

// Deployed URL for a preset derivative of a source entity (ADR-0011).
// Mirrors renderPresets' destination: <assetsFolder>/<preset>/<name>, with
// the extension swapped to the preset's `format` (absent → keep the source
// extension). `assetsFolder` is the served root for derivatives ('assets',
// or '<outputFolder>/assets'). `changeExtension` is passed in so this stays
// a pure, engine-free helper. Base-relative — a render target prefixes the
// origin; a same-origin consumer uses it as-is.
export function presetUrl({ assetsFolder, preset, name, format, changeExtension }) {
    const destination = format ? changeExtension(name, format) : name
    return '/' + path.posix.join(assetsFolder, preset, destination)
}

export function assets(options = {}) {
    return ({
        runtime,
        onLoaded,
        useLogger,
        onImport,
        watch,
        onProcessed,
        onBeforeRender,
        useJournal,
        createEntity,
        updateEntity,
        deleteEntity,
        renderEntities,
        onComplete,
        onSync,
        onFinalize,
        findEntity,
        iterateEntities,
        matchEntity,
        changeExtension,
        constants: { ACTION, OPERATION },
    }) => {
    const collection = 'presets'
    const type = 'preset'
    const checksumMap = new Set()

    // A preset that matches nothing builds green and says nothing, which is
    // how a mistyped pattern ships. `files({ outputFolder })` prefixes `name`
    // and `meta.url` but NOT `id`, and `match` runs against `id` — so
    // '/files/media/devices/**' looks right and matches zero. Tallied here,
    // reported once per process at onFinalize.
    const matchTally = { evaluated: 0, matched: new Set(), reported: false }

    // Which presets select this entity. No counters, no side effects.
    //
    // Split out because the same question gets asked twice for different
    // reasons: once as files enter the catalog, where the answer drives the
    // render and feeds the unmatched-preset tally, and once after the cycle to
    // explain a derivative that is not there. The second must not move the
    // counters the first reports on.
    //
    // `some`, not a push per matching pattern. Two patterns that both cover a
    // file used to name their preset twice in the list; the second render was
    // gated by the checksum, so nothing rendered twice — but "which presets
    // cover this file" is a question with one answer, and the explainer below
    // puts that answer in front of a reader.
    function presetsSelecting(entity) {
        const selected = []
        for (const preset in (options.presets || {})) {
            const { matches } = normalizePresetConfig(options.presets[preset])
            if (matches.some(match => matchEntity(entity, match))) selected.push(preset)
        }
        return selected
    }

    async function getEntityPresets(entity) {
        matchTally.evaluated++
        const selected = presetsSelecting(entity)
        for (const preset of selected) matchTally.matched.add(preset)
        return selected
    }

    // Why a linked derivative is not in the output.
    //
    // The engine detects the CONSEQUENCE — it knows what the output points at
    // and what exists on disk — but it cannot name the cause, because whether
    // a preset covers a file is decided by `match` against the entity id and
    // none of that is visible from a url. So one sentence covered a mistyped
    // preset name, a preset that did not run, and a file no preset was ever
    // asked to cover. The last is the common one, the only one whose fix is in
    // the config rather than in the template, and the one the reader is least
    // likely to guess.
    //
    // Answered here rather than in the helper: `asset()` takes a path, not an
    // entity, and it is the hottest call in a render. Nothing is looked up
    // when the url is built. This runs at most a handful of times, after
    // everything has settled, and only when something is already wrong.
    // A derivative wears the PRESET's extension, so a source is found by stem:
    // `media/hero.webp` came from `media/hero.jpg`.
    const stemOf = (value) => value.slice(0, value.length - path.extname(value).length)

    // stem(entity.name) -> entities, built once per cycle.
    //
    // Two callers ask the same question from opposite directions — "why is
    // this derivative missing" and "does this derivative still have a source"
    // — so they share one index rather than each walking the catalog.
    let sourceIndex = null
    let sourceIndexCycle
    async function sourceByStem() {
        const cycle = runtime.state?.cycle?.id ?? null
        if (sourceIndexCycle !== cycle) { sourceIndex = null; sourceIndexCycle = cycle }
        if (!sourceIndex) {
            sourceIndex = new Map()
            for await (const candidate of iterateEntities({ collection: { $ne: collection } })) {
                if (typeof candidate.name !== 'string') continue
                const key = stemOf(candidate.name)
                if (!sourceIndex.has(key)) sourceIndex.set(key, [])
                sourceIndex.get(key).push(candidate)
            }
        }
        return sourceIndex
    }

    async function explainMissing(destination) {
        const assetsName = runtime.options.assets
        const parts = String(destination).replace(/^\/+/, '').split('/')
        if (!assetsName || parts[0] !== assetsName || parts.length < 3) return null
        const preset = parts[1]
        const name = parts.slice(2).join('/')

        const configured = Object.keys(options.presets || {}).sort()
        if (!options.presets?.[preset]) {
            return `no preset named '${preset}' is configured (configured: ${configured.join(', ') || 'none'})`
        }

        // Built only on this path: a build with nothing broken never walks
        // the catalog for it.
        const index = await sourceByStem()
        const source = (index.get(stemOf(name)) ?? [])[0]
        if (!source) {
            return `no source file is named '${stemOf(name)}' — nothing would produce this derivative `
                + 'under any preset'
        }

        const owns = presetsSelecting(source)
        if (owns.includes(preset)) {
            return `preset '${preset}' does cover ${source.id}, so the derivative should be there — it was `
                + 'not produced this cycle (the preset render failed, or the preset changed and only '
                + '--render-presets re-derives what is already in the catalog)'
        }
        const { matches } = normalizePresetConfig(options.presets[preset])
        return `preset '${preset}' does not cover ${source.id} — its match is `
            + `${matches.join(', ') || '(none)'}`
            + (owns.length
                ? `. Presets that do cover it: ${owns.join(', ')}`
                : '. No configured preset covers it')
    }

    // Report presets that matched none of the entities this run evaluated.
    //
    // Deliberately phrased as what was OBSERVED rather than "this preset is
    // broken": an incremental cycle only re-evaluates changed entities, so a
    // preset can legitimately match nothing in a run of three. The count and
    // the --force hint let the reader tell the two apart, which a bare
    // "matched nothing" would not. Once per process, so watch mode is quiet.
    function reportUnmatchedPresets(logger) {
        if (matchTally.reported) return
        const configured = Object.keys(options.presets || {})
        if (!configured.length || !matchTally.evaluated) return
        // Only when the cycle evaluated everything. On an incremental run the
        // evaluated set is whatever changed, so a healthy preset matches
        // nothing in a run of two and the warning fires on every build —
        // which trains the reader to filter it, and the filtered-out line is
        // the real one. The message already told the reader to use --force to
        // check the whole catalog; that condition gates it now instead of
        // annotating it.
        if (!isFullCycle(runtime)) return
        matchTally.reported = true

        for (const preset of configured) {
            if (matchTally.matched.has(preset)) continue
            const { matches } = normalizePresetConfig(options.presets[preset])
            logger.warn(
                { code: 'preset-no-match', preset, evaluated: matchTally.evaluated, patterns: matches },
                'Assets preset %j matched none of the %d entities evaluated (patterns: %s). ' +
                'Patterns run against entity.id, which files({ outputFolder }) does NOT prefix — ' +
                'the prefix appears on name and meta.url only.',
                preset, matchTally.evaluated, matches.join(', '))
        }
    }

    // Resolve a preset name to an importable module location. Local
    // files in presetsFolder win; names with no local file fall back to
    // an npm package named `mikser-io-preset-<name>`, resolved from the
    // project's node_modules. Mirrors how postprocess.js resolves
    // post-* plugins — local override first, then the npm convention.
    // Returns { uri, watchable } or null when neither exists.
    //
    // `watchable` distinguishes the two lifetimes: local presets are
    // re-imported (cache-busted) on every load so watch-mode edits take
    // effect; npm presets are versioned by their package, imported once.
    function resolvePreset(name) {
        const local = path.join(runtime.options.presetsFolder, `${name}.js`)
        if (existsSync(local)) {
            return { uri: local, watchable: true }
        }
        try {
            const require = createRequire(path.join(runtime.options.workingFolder, 'package.json'))
            const uri = require.resolve(`mikser-io-preset-${name}`)
            return { uri, watchable: false }
        } catch {
            return null
        }
    }

    // Import a preset module and build its catalog entity. One place for
    // the (revision, format, options) export contract so onImport and
    // onSync stay in sync. Cache-busts local presets so watch-mode edits
    // reload; npm presets import once (their version is the cache key).
    // Presets whose effective definition moved this cycle: a bumped revision,
    // an edited module, or widened patterns.
    //
    // The fan-out this gates is a full catalog scan, and onImport writes every
    // preset entity on every build — so gating on "a preset is in the journal"
    // ran that scan every cycle, including a no-op watch rebuild, where
    // responsiveness matters most.
    const changedPresets = new Set()

    async function notePresetChange(preset) {
        const prior = await findEntity({ id: preset.id })
        const moved = !prior
            || prior.checksum !== preset.checksum
            || JSON.stringify(prior.matches ?? null) !== JSON.stringify(preset.matches ?? null)
        if (moved) changedPresets.add(preset.name)
        return moved
    }

    async function buildPreset({ name, uri, watchable }) {
        const cacheBust = watchable ? `?stamp=${Date.now()}` : ''
        // `options` here would SHADOW the plugin's own config, which the
        // patterns below need. The module's export and the factory argument
        // are two different things that were both called options.
        const { revision = 1, format, options: moduleOptions } = await import(`${uri}${cacheBust}`)
        return {
            id: `/presets/${name}`,
            collection,
            type,
            uri,
            name,
            source: uri,
            format,
            checksum: revision,
            // The patterns this preset selects by, carried on the entity.
            //
            // They are half of what decides which files a preset owns, and
            // they live in CONFIG rather than in the module — so `revision`
            // alone cannot say the preset's effective definition moved.
            // Widening a pattern was a silent no-op: match is evaluated as a
            // file ENTERS the catalog, so a wider one left everything already
            // in it alone, the build stayed green and the derivative never
            // appeared.
            matches: normalizePresetConfig(options.presets?.[name]).matches,
            options: moduleOptions,
        }
    }

    async function getRevisions(entity) {
        let revisions = await globby(`${entity.destination.replaceAll('(', '\\(').replaceAll(')', '\\)')}.*.md5`, {
            cwd: path.join(runtime.options.assetsFolder, entity.preset.name),
            expandDirectories: false,
            onlyFiles: true
        })
        return revisions
    }

    async function isPresetRendered(entity) {
        let result = false
        let revisions = []
        const assetChecksum = `${entity.destination}.${entity.preset.checksum}.md5`
        if (checksumMap.has(assetChecksum)) {
            revisions.push(assetChecksum)
        } else {
            revisions = await getRevisions(entity)
        }

        for (let revision of revisions) {
            const [assetsRevision] = revision.split('.').slice(-2, -1)
            if (entity.preset.checksum <= Number.parseInt(assetsRevision)) {
                if (entity.preset.options?.checksum === false) {
                    result = true
                    break
                }

                let checksum = await readFile(revision, 'utf8')
                result ||= checksum == entity.checksum
                if (result) break
            }
        }
        return result
    }

    async function renderPresets(entities, { rendererChanged = new Set() } = {}) {
        const { presets, assetsMap } = runtime.state.assets

        const tasks = []
        for (let entityToRender of entities) {
            for (let entityPreset of assetsMap[entityToRender.id] || []) {
                const entity = _.cloneDeep(entityToRender)
                entity.preset = presets[entityPreset]
                // Named in config but with no module in presets/ and no
                // mikser-io-preset-* package: there is nothing to render with.
                // Loading already reported this preset ('Preset not found'),
                // and the finalize check names the links left dangling. A line
                // per entity here would just be that fact a third time, once
                // per matched file.
                if (!entity.preset) continue
                // Per-preset config options override the preset module's
                // defaults. Looked up at render time so config edits are
                // picked up on the next cycle without rebuilding the
                // preset entity from its module.
                const { options: configOptions } = normalizePresetConfig(
                    options.presets?.[entityPreset]
                )
                let destination = entity.name
                if (entity.preset.format) {
                    destination = changeExtension(destination, entity.preset.format)
                }
                entity.destination = path.join(runtime.options.assetsFolder, entityPreset, destination)
                // Two gates sit between a scheduled entity and a render: the
                // manifest's "its source did not change", and this plugin's
                // marker. A forced render clears both — a marker at the
                // current revision is exactly what --render-presets exists to
                // disregard.
                const forced = rendererChanged.has(entityToRender.id)
                const ignore = forced ? false : await isPresetRendered(entity)
                tasks.push({
                    entity,
                    options: {
                        ...entity.preset.options,    // module defaults
                        ...configOptions,             // config overrides
                        renderer: 'preset',
                        // The preset itself moved this cycle, so the manifest's
                        // "its source is unchanged" is true and beside the
                        // point. See the skip decision in engine.js.
                        rendererChanged: forced,
                        ignore
                    }
                })
            }
        }
        await renderEntities(tasks)

    }

    onLoaded(async () => {
        const logger = useLogger()

        const assetsName = options.assetsFolder || 'assets'
        runtime.state.assets = {
            presets: {},
            assetsMap: {},
            assetsFolder: options.outputFolder
                ? path.join(options.outputFolder, assetsName)
                : assetsName,
        }

        // The engine asks this when a linked derivative is not on disk.
        //
        // On runtime.engine, NOT on runtime.state. State is structured-cloned
        // into render and postprocess workers, and a function cannot be
        // cloned: putting it there made every worker-dispatched render fail
        // with DataCloneError on any build that loads this plugin, reported as
        // a render error whose message was this function's own source. Options
        // already had workerSafeOptions for exactly this hazard; state had no
        // equivalent, so state is the wrong place to publish anything callable.
        //
        // Still published rather than imported, so the engine keeps knowing
        // nothing about presets and says nothing when this plugin is absent.
        runtime.engine ??= {}
        runtime.engine.assets = { explainMissing }

        runtime.options.presets = options.presetsFolder || collection
        runtime.options.presetsFolder = path.join(runtime.options.workingFolder, runtime.options.presets)
        logger.debug('Presets folder: %s', runtime.options.presetsFolder)
        await mkdir(runtime.options.presetsFolder, { recursive: true })

        runtime.options.assets = options.assetsFolder || 'assets'
        runtime.options.assetsFolder = path.join(runtime.options.workingFolder, runtime.options.assets)
        logger.debug('Assets folder: %s', runtime.options.assetsFolder)

        // --clear means "throw away what was derived and build it again", and
        // derivatives are derived — but this folder sits at the working-folder
        // root, outside both outputFolder and runtimeFolder, so the engine's
        // clear never reached it. Anything here whose source had gone stayed
        // forever: still on disk, still SERVED through the symlink below, and
        // invisible to `find out -type f` because that tree is reached through
        // a link. The only way out was deleting the folder by hand.
        //
        // Cleared here rather than in the engine because the path is not known
        // until this plugin resolves it — the engine's clear runs before any
        // plugin's onLoaded.
        //
        // Whole folder, not a sweep of orphans: identifying an orphan means
        // mapping a derivative back to a source, which is the id/name mapping
        // that has bitten this plugin twice. --clear already accepts a full
        // rebuild, so re-deriving is the honest cost of asking for one.
        if (runtime.options.clear) {
            await rm(runtime.options.assetsFolder, { recursive: true, force: true })
            logger.info('Assets cleared: %s', runtime.options.assetsFolder)
        }

        await mkdir(runtime.options.assetsFolder, { recursive: true })

        let link = path.join(runtime.options.outputFolder, runtime.options.assets)
        if (options.outputFolder) link = path.join(runtime.options.outputFolder, options.outputFolder, runtime.options.assets)
        try {
            await mkdir(path.dirname(link), { recursive: true })
            await symlink(path.resolve(runtime.options.assetsFolder), link, 'dir')
        } catch (err) {
            if (err.code != 'EEXIST')
                throw err
        }

        watch(collection, runtime.options.presetsFolder)
    })

    onSync(collection, async ({ action, context }) => {
        if (!context.relativePath) return false
        const { relativePath } = context

        const logger = useLogger()
        const { presets } = runtime.state.assets

        // Watch only fires for files in presetsFolder, so these are
        // always local presets — watchable: true.
        const name = relativePath.replace(path.extname(relativePath), '')
        const uri = path.join(runtime.options.presetsFolder, relativePath)

        let synced = true
        switch (action) {
            case ACTION.CREATE:
                try {
                    const preset = await buildPreset({ name, uri, watchable: true })
                    presets[name] = preset
                    await createEntity(preset)
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.UPDATE:
                try {
                    const preset = await buildPreset({ name, uri, watchable: true })
                    // Was `!preset[name]` — a typo for `!presets[name]`
                    // that made every UPDATE take the create branch
                    // (preset[name] is always undefined). Fixed: only
                    // re-emit when the revision actually changed.
                    if (!presets[name]) {
                        presets[name] = preset
                        await createEntity(preset)
                    } else if (presets[name].checksum != preset.checksum) {
                        presets[name] = preset
                        await updateEntity(preset)
                    } else {
                        synced = false
                    }
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.DELETE:
                delete presets[name]
                await deleteEntity({
                    id: path.join('/presets', relativePath),
                    collection,
                    type,
                })
                break
        }
        return synced
    })

    onImport(async () => {
        const logger = useLogger()
        const { presets } = runtime.state.assets

        // Local presets: scan the presets folder. Loads every *.js
        // there, keyed by filename. Local always wins.
        const paths = await globby('*.js', { cwd: runtime.options.presetsFolder })
        for (let relativePath of paths) {
            const name = relativePath.replace(path.extname(relativePath), '')
            const uri = path.join(runtime.options.presetsFolder, relativePath)
            try {
                const preset = await buildPreset({ name, uri, watchable: true })
                await notePresetChange(preset)
                await createEntity(preset)
                presets[name] = preset
            } catch (err) {
                logger.error(err, 'Preset loading error: %s', uri)
            }
        }

        // npm presets: any preset name referenced in config that no
        // local file already provided resolves to an npm package
        // `mikser-io-preset-<name>`. Config is the source of truth for
        // which presets a project uses; this fills the names a folder
        // scan can't (the code lives in node_modules, not presets/).
        for (const name of Object.keys(options.presets || {})) {
            if (presets[name]) continue   // a local file already loaded it
            const resolved = resolvePreset(name)
            if (!resolved) {
                logger.error(
                    'Preset not found: %s (no presets/%s.js, no npm package mikser-io-preset-%s)',
                    name, name, name,
                )
                continue
            }
            try {
                const preset = await buildPreset({ name, uri: resolved.uri, watchable: resolved.watchable })
                await notePresetChange(preset)
                await createEntity(preset)
                presets[name] = preset
                logger.debug('Preset loaded from npm: mikser-io-preset-%s', name)
            } catch (err) {
                logger.error(err, 'Preset loading error (npm): mikser-io-preset-%s', name)
            }
        }
    })

    onProcessed(async (signal) => {
        const logger = useLogger()
        const { assetsMap } = runtime.state.assets

        for await (let { entity, operation } of useJournal('Assets processing', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE], signal)) {
            if (entity.collection != collection) {
                switch (operation) {
                    case OPERATION.CREATE:
                    case OPERATION.UPDATE:
                        const entityPresets = await getEntityPresets(entity)
                        if (entityPresets.length) {
                            logger.debug('Presets matched for: %s %s', entity.collection, entity.id, entityPresets.length)
                            assetsMap[entity.id] = entityPresets
                            // ADR-0011: stamp deployed preset URLs onto the
                            // source entity so a $-ref to it expands to its
                            // derivatives. Same destination as renderPresets;
                            // recorded here where the matched presets are known.
                            // Auto-persisted via useJournal (mutate-and-move-on).
                            const { presets } = runtime.state.assets
                            const urls = {}
                            for (const presetName of entityPresets) {
                                urls[presetName] = presetUrl({
                                    assetsFolder: runtime.state.assets.assetsFolder,
                                    preset: presetName,
                                    name: entity.name,
                                    format: presets[presetName]?.format,
                                    changeExtension,
                                })
                            }
                            entity.meta = { ...entity.meta, presets: urls }
                        }
                        break
                    case OPERATION.DELETE:
                        delete assetsMap[entity.id]
                        break
                }
            }
        }
    })

    onBeforeRender(async signal => {
        const { assetsMap } = runtime.state.assets

        checksumMap.clear()
        const checksumFiles = await globby('**/*.md5', { cwd: runtime.options.assetsFolder })
        for (let checksumFile of checksumFiles) {
            checksumMap.add(path.join(runtime.options.assetsFolder, checksumFile))
        }

        const entitiesToRender = new Map()
        // Entities that must render regardless of markers or manifest: their
        // preset moved, or --render-presets asked for them.
        const presetMoved = new Set()

        // --render-presets [name]: re-derive though nothing moved.
        //
        // The escape hatch for what the incremental machinery cannot see — a
        // preset edited without bumping `revision`, a marker deleted by hand,
        // an image library upgraded underneath the build. --clear reaches the
        // same end only by rebuilding the whole site, and only at startup, so
        // it cannot be asked of a running watcher at all.
        const wanted = runtime.options.renderPresets
        if (wanted) {
            // Consumed here and nowhere else. The engine checks this at the
            // end of the cycle: a flag that reaches no plugin has to say so,
            // rather than building normally and leaving the operator to
            // notice nothing was re-derived.
            runtime.state.assets.renderPresetsHandled = true

            const known = Object.keys(runtime.state.assets.presets)
            const names = wanted === true ? known : [wanted]
            for (const name of names.filter(n => !known.includes(n))) {
                useLogger().warn({ code: 'preset-unknown', preset: name },
                    '--render-presets asked for %j, which is not configured. Known: %s',
                    name, known.join(', ') || '(none)')
            }
            const selected = names.filter(n => known.includes(n))
            if (selected.length) {
                for await (const candidate of iterateEntities({ collection: { $ne: collection } })) {
                    const candidatePresets = await getEntityPresets(candidate)
                    if (!candidatePresets.some(n => selected.includes(n))) continue
                    assetsMap[candidate.id] ??= candidatePresets
                    presetMoved.add(candidate.id)
                    entitiesToRender.set(candidate.id, candidate)
                }
                useLogger().info('Presets re-rendering: %s (%d source(s))',
                    selected.join(', '), entitiesToRender.size)
            }
        }
        await map(useJournal('Assets provision', [OPERATION.CREATE, OPERATION.UPDATE], signal), async ({ entity }) => {
            if (entity.collection == collection) {
                // Only when this preset's definition actually moved.
                if (!changedPresets.has(entity.name)) return
                // A preset moved — its `revision` was bumped, or its module
                // changed. Everything that uses it has to re-render.
                //
                // Asked of the CATALOG, not of assetsMap. That map is built
                // from this cycle's journal, so on a build where only the
                // preset moved it is empty and this fan-out reached nothing:
                // no asset was scheduled, the reuse check that would have
                // said "the marker is too old" was never consulted, and the
                // startup sweep deleted the old markers anyway because it
                // walks the folder rather than the entities.
                //
                // The result was the worst available shape. Bumping `revision`
                // — the documented way to force a rebuild — removed the marker
                // and left the derivative at its old bytes. It looked like it
                // had worked, nothing in the report said otherwise, and where
                // the derived folder is gitignored the deployment served stale
                // images until someone deleted the folder by hand.
                //
                // getEntityPresets is the same matcher the per-entity path
                // uses, so there is one implementation of "does this entity
                // use this preset" rather than a second one here that can
                // drift.
                for await (const candidate of iterateEntities({ collection: { $ne: collection } })) {
                    const candidatePresets = await getEntityPresets(candidate)
                    if (!candidatePresets.includes(entity.name)) continue
                    // renderPresets reads the presets to render off this map,
                    // and on a preset-only build nothing else populated it.
                    assetsMap[candidate.id] ??= candidatePresets
                    presetMoved.add(candidate.id)
                    if (!entitiesToRender.has(candidate.id)) {
                        entitiesToRender.set(candidate.id, candidate)
                    }
                }
            } else {
                if (assetsMap[entity.id] && !entitiesToRender.has(entity.id)) {
                    entitiesToRender.set(entity.id, entity)
                }
            }
        }, { concurrency: 10, signal })

        await renderPresets(entitiesToRender.values(), { rendererChanged: presetMoved })
    })

    onComplete(async ({ entity, options }) => {
        const logger = useLogger()
        if (entity.preset && !options?.ignore) {
            await mkdir(path.dirname(entity.destination), { recursive: true })
            const assetChecksum = `${entity.destination}.${entity.preset.checksum}.md5`
            await writeFile(assetChecksum, entity.checksum, 'utf8')
            logger.debug('Asset render finished: [%s] %s', assetChecksum, entity.destination.replace(runtime.options.workingFolder, ''))
        }
    })

    onFinalize(async () => {
        const logger = useLogger()
        const { presets } = runtime.state.assets

        reportUnmatchedPresets(logger)

        // How much of the catalog this run actually looked at.
        //
        // The warning above only fires on a full cycle, because on an
        // incremental one a healthy preset legitimately matches nothing. That
        // is correct and it leaves the reverse question unanswered: a NEW
        // pattern that never had the chance to match anything looks exactly
        // like a run with nothing to do. `evaluated 4 of 397` answers it
        // without needing a warning to decide whether to fire.
        try {
            // COUNT(*), not a fetch: the denominator is a number, and paying a
            // full scan and a JSON.parse per row to produce it would make the
            // diagnostic cost more than the thing it diagnoses.
            reportEvaluated('assets', {
                evaluated: matchTally.evaluated,
                of: countEntities({ collection: { $ne: collection } }),
            })
        } catch { /* a count is not worth failing a build over */ }

        let revisions = await globby('**/*.md5', { cwd: runtime.options.assetsFolder })

        // Is the catalog answerable at all?
        //
        // Every check below concludes "no source, therefore orphan", and an
        // EMPTY catalog answers that for every derivative on the site. A
        // failed import or a scan that has not run yet would then delete the
        // whole assets folder — a rebuild of every derivative at best, and at
        // worst it happens on the machine that serves them. So the sweep only
        // runs when there is something to be absent from.
        const catalogSize = countEntities({ collection: { $ne: collection } })
        const orphaned = []

        for (let revision of revisions) {
            const [preset] = revision.split(path.sep)
            const [assetsRevision] = revision.split('.').slice(-2, -1)

            if (!presets[preset]) {
                const assetsPresetFolder = path.join(runtime.options.assetsFolder, preset)
                // `let`. This was `const` with an assignment inside the try,
                // so removing a preset folder threw TypeError into the empty
                // catch on every pass and the log line was unreachable — the
                // rm had already happened, so nothing looked wrong.
                let assetsPresetRemoved = false
                try {
                    await rm(assetsPresetFolder, { recursive: true, force: true })
                    assetsPresetRemoved = true
                } catch { /* already gone, or not ours to remove */ }
                if (assetsPresetRemoved) {
                    logger.debug('Assets preset removed: %s', assetsPresetFolder)
                }
                continue
            }

            if (Number.parseInt(assetsRevision) < presets[preset].checksum) {
                await unlink(path.join(runtime.options.assetsFolder, revision))
            }

            // A derivative whose source is gone, or which this preset no
            // longer covers.
            //
            // Deleting the source removed its catalog row and its published
            // file, and left the derivative — the delete handler dropped the
            // in-memory mapping and nothing on disk, so the only cleanup was
            // --clear or doing it by hand. Narrowing a preset's `match` left
            // one the same way, with nothing said.
            //
            // Answered from the catalog rather than from the delete event: a
            // delete entry is sparse ({ id, type, collection }) by convention
            // in every source plugin, so it cannot say where the derivative
            // went. What still HAS a source is a question the catalog answers
            // whatever route the orphan arrived by.
            if (!catalogSize) continue
            const derivative = revision.replace(/\.[^.]+\.md5$/, '')
            const name = derivative.split(path.sep).slice(1).join('/')
            const index = await sourceByStem()
            const source = (index.get(stemOf(name)) ?? [])[0]
            if (source && presetsSelecting(source).includes(preset)) continue
            orphaned.push({
                derivative,
                marker: revision,
                reason: source ? `preset '${preset}' no longer covers ${source.id}` : 'its source is gone',
            })
        }

        for (const { derivative, marker } of orphaned) {
            await unlink(path.join(runtime.options.assetsFolder, derivative)).catch(() => { /* already gone */ })
            await unlink(path.join(runtime.options.assetsFolder, marker)).catch(() => { /* already gone */ })
        }
        if (orphaned.length) {
            logger.info('Assets removed: %d derivative(s) with no source — %s',
                orphaned.length,
                orphaned.slice(0, 3).map(o => `${o.derivative} (${o.reason})`).join(', ')
                + (orphaned.length > 3 ? ` and ${orphaned.length - 3} more` : ''))
        }
    })

        return {
            collection,
            type,
        }
    }
}
