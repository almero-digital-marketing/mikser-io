// What a principal may do, in words rather than in capability strings.
//
// Enforcement only ever needs the flat list: does this credential carry
// `drive:layouts:write`, yes or no. That is enough to refuse a request and not
// nearly enough to EXPLAIN one. A session holding eighteen capabilities cannot
// tell whether those eighteen are a role called admin, whether narrower roles
// exist, or which one it is acting as — so an admin token and a site with no
// roles configured look exactly the same from inside.
//
// The difference shows up in what an agent says when it is stopped:
//
//   "I got a 403 writing to styles/tokens/buttons.css."
//   "I'm connected as editor, which does not include drive:styles:write.
//    That file is the design system — this needs whoever built the site."
//
// The first invites working around the refusal. The second is a sentence the
// end user can forward to the person who can actually do it.
//
// INFORMATIONAL, deliberately and permanently. Naming the role that could do
// something is how a handoff is made possible; there is no way to ask for one
// and none should be added. A role is a decision about a person, taken by
// whoever configures the site, and an agent's part in it is to say what it
// cannot do and stop.

// Capabilities follow `drive:<name>` to read and `drive:<name>:write` to
// write. That convention is the whole mapping — it needs no list of endpoints
// to stay correct as collections are added.
const DRIVE = /^drive:([^:]+)(?::write)?$/

// Split a capability list into what it can change and what it can only look
// at. `readOnly` is the field that makes a refusal explainable, and it is more
// useful than the capabilities it is derived from because it is already in the
// vocabulary the person asking uses: collection names, not verbs.
export function reachOf(capabilities = []) {
    const readable = new Set()
    const writable = new Set()
    for (const capability of capabilities ?? []) {
        const m = DRIVE.exec(capability)
        if (!m) continue
        readable.add(m[1])
        if (capability.endsWith(':write')) writable.add(m[1])
    }
    return {
        writable: [...writable].sort(),
        readOnly: [...readable].filter(name => !writable.has(name)).sort(),
    }
}

// Which role is in force.
//
// A principal can hold several. Naming one of them anyway would be a lie, so
// the answer is the role whose capabilities cover every other role held —
// there usually is one, because roles are written as widening tiers. When none
// dominates, the acting authority genuinely is the union and `role` is null
// with `roles` naming the parts.
export function actingRole(held = [], catalogue = {}) {
    const names = (held ?? []).filter(name => catalogue[name])
    if (!names.length) return null
    if (names.length === 1) return names[0]
    const covers = (a, b) => {
        const set = new Set(catalogue[a] ?? [])
        return (catalogue[b] ?? []).every(capability => set.has(capability))
    }
    return names.find(candidate => names.every(other => covers(candidate, other))) ?? null
}

// Every role and what it may do, with the acting one marked.
//
// One list rather than two. A "roles you do not have" field cannot describe
// the site to whoever holds the widest one — an admin sees an empty array and
// concludes no other roles exist — and a reader comparing their own reach
// against someone else's needs both sides in the same shape anyway.
//
// Roles are not credentials. Naming them, and saying what each can reach, is
// what makes a handoff possible: it tells an agent who to ask. It reveals
// nothing about how to become one, and there is no way to ask for one.
export function rolesIn(catalogue = {}, { acting = null, summaries = {} } = {}) {
    return Object.entries(catalogue).map(([name, capabilities]) => {
        const { writable, readOnly } = reachOf(capabilities)
        // Capabilities that name no collection — api verbs, mcp:use. Kept so
        // a role is described completely rather than only in the part of it
        // that happens to map to folders.
        const also = (capabilities ?? []).filter(capability => !/^drive:/.test(capability)).sort()
        return {
            name,
            ...(name === acting ? { acting: true } : {}),
            ...(summaries[name] ? { summary: summaries[name] } : {}),
            writable,
            readOnly,
            ...(also.length ? { also } : {}),
        }
    })
}

// Everything a session should be able to say about its own authority.
export function describeAuthority({ capabilities, roles = [], catalogue = {}, summaries = {} } = {}) {
    // No capability map configured at all: the credential is not
    // capability-scoped and the endpoint's own operations are the only limit.
    // Reporting a role here would invent one.
    if (capabilities == null) {
        return {
            role: null,
            roleSummary: 'This site has no roles configured, so this credential is limited only by what the '
                + 'endpoint itself allows.',
            capabilities: null,
            writable: null,
            readOnly: null,
            roles: [],
        }
    }
    const role = actingRole(roles, catalogue)
    const { writable, readOnly } = reachOf(capabilities)
    return {
        role,
        // Only when no single role covers the others: the acting authority is
        // then the union, and naming one of them would be a lie.
        ...(roles?.length && !role ? { heldRoles: roles } : {}),
        ...(summaries[role] ? { roleSummary: summaries[role] } : {}),
        writable,
        readOnly,
        roles: rolesIn(catalogue, { acting: role, summaries }),
    }
}

// The sentence an agent should repeat when a role stops it.
//
// Names the role, the capability it lacks and who has it, in that order,
// because that is the order the reader needs them: what I am, what is missing,
// who to ask. Deliberately without a suggestion to retry, escalate or work
// around it — the correct next step is a person, not another call.
export function explainRefusal({ capability, role, target, catalogue = {}, summaries = {} } = {}) {
    const holders = Object.entries(catalogue)
        .filter(([, capabilities]) => (capabilities ?? []).includes(capability))
        .map(([name]) => name)
    // Trim the summary's own full stop: it is a sentence in its own right and
    // reads as a typo when a second one lands beside it.
    const summary = summaries[holders[0]]?.replace(/\.\s*$/, '')
    const who = holders.length
        ? `The ${holders.join(' or ')} role carries it${summary ? ` — ${summary}` : ''}.`
        : 'No configured role carries it.'
    return [
        role ? `Connected as ${role}, which does not include ${capability}.` : `This credential lacks ${capability}.`,
        target ? `That is what writing to ${target} needs.` : null,
        who,
        'Ask whoever set the site up; this is not something to work around.',
    ].filter(Boolean).join(' ')
}
