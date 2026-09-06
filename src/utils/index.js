// Shared pure helpers.
//
// One file until 10.12.0, and "utils" named nothing: 34 exports with no
// relationship beyond having nowhere else to live. Split by what each group
// is actually about, so a reader looking for how a ref resolves does not
// scroll past mime sniffing to find it.
//
// This is the surface. Everything imported from './utils/index.js' is
// re-exported here, so the split costs no caller anything.

export { changeExtension, getFormatInfo, isTextEntity, looksTextual, matchEntity, mimeForEntity, projectMeta, readEntityContent, useCollection } from './entity.js'
export { AbortError, formatErrorContext, formatLogArgs } from './errors.js'
export { ExpandError, expandEntity } from './expand.js'
export { checksum, checksumOf, diffInputParts, inputHashOf, inputPartsOf, normalize } from './hash.js'
export { JUNK_IGNORE, isJunkPath, junkFilter, junkIgnore, registerJunk } from './junk.js'
export { matchesLibrary } from './library.js'
export { isLoopback, loopbackOnly } from './net.js'
export { siteRelativeUrl, siteRootFor, writeEntity, writeOutput, registerSourceFormat, sourceFormatFor } from './output.js'
export { extractRefs, isRefKey, lookupKeys, matchesRef, refFilter } from './refs.js'
