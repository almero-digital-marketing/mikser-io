import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onInitialized, onPersist, onFinalized } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { Low } from 'lowdb'
import path from 'node:path'
import { JSONFile } from 'lowdb/node'
import _ from 'lodash'

let catalog

// Same reasoning as journal.js — initialize the catalog in
// onInitialized so every plugin hook from onLoad onwards can safely
// call findEntity / findEntities and write through the journal.
// catalog.js imports useJournal from journal.js, so journal.js's
// onInitialized registers first within the phase — its hook runs
// before this one.
onInitialized(async () => {
	const adapter = new JSONFile(path.join(runtime.options.runtimeFolder, `catalog.json`))
	catalog = new Low(adapter, {
		entities: [],
	})
	catalog.chain = _.chain(catalog).get('data')
	runtime.catalog = catalog
})

onPersist(async () => {
	const logger = useLogger()
	for await (let { operation, entity } of useJournal('Catalog')) {
		switch (operation) {
			case OPERATION.CREATE:
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				catalog.data.entities.push(entity)
				break
			case OPERATION.UPDATE: {
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				// Upsert semantics: if the entity doesn't already exist,
				// treat UPDATE as CREATE. Plugins that "ensure an entity
				// is in the catalog" can call runtime.update without a
				// findEntity-then-branch dance. Previously a no-op when
				// the id was new, which was a silent footgun.
				const existing = catalog.chain.get('entities').find({ id: entity.id }).value()
				if (existing) {
					catalog.chain.get('entities').find({ id: entity.id }).assign(entity).value()
				} else {
					catalog.data.entities.push(entity)
				}
				break
			}
			case OPERATION.DELETE:
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				catalog.chain.get('entities').remove({ id: entity.id }).value()
				break
		}
	}
})

onFinalized(async () => {
	await catalog.write()
})

export async function findEntity(query) {
	if (!query) return
	return catalog.chain.get('entities').find(query).value()
}

export async function findEntities(query) {
	if (!query) {
		return catalog.chain.get('entities').value()
	}
	return catalog.chain.get('entities').filter(query).value()
}
