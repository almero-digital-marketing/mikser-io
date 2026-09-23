// The exact bytes of a Basic challenge.
//
// `charset="UTF-8"` was hardcoded at five call sites across two packages, and
// it cost a Windows deployment its mapped drive: the WebDAV mini-redirector
// appears not to parse the parameter, and a challenge carrying it left the
// client unable to reconnect from stored credentials at all. Measured
// before/after on a live host with the parameter stripped at the proxy as the
// only variable — the client went from never sending an Authorization header
// to offering Basic unprompted.
//
// RFC 7617 §2.1 on what it buys: "This information is purely advisory." It
// asks a client to encode user-pass as UTF-8 NFC. For ASCII credentials —
// nearly all of them — a client that ignores it behaves identically.
//
// Asserted as exact strings rather than with a regex, because the whole
// finding is about a parameter being present or absent.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { basicChallenge } from '../../src/auth.js'

describe('basicChallenge', () => {
    it('omits charset by default', () => {
        assert.equal(basicChallenge({ realm: 'mikser' }), 'Basic realm="mikser"')
    })

    it('emits it exactly as RFC 7617 writes it when asked', () => {
        assert.equal(basicChallenge({ realm: 'mikser', charset: true }),
            'Basic realm="mikser", charset="UTF-8"')
    })

    it('defaults the realm rather than emitting an empty one', () => {
        assert.equal(basicChallenge(), 'Basic realm="mikser"')
        assert.equal(basicChallenge({}), 'Basic realm="mikser"')
    })

    it('escapes a realm that would otherwise end the field early', () => {
        // A quoted-string, so a bare quote inside it hands the rest of the
        // header to the parser as garbage. Impossible to get right at five
        // call sites and trivial in one.
        assert.equal(basicChallenge({ realm: 'say "hi"' }), 'Basic realm="say \\"hi\\""')
        assert.equal(basicChallenge({ realm: 'back\\slash' }), 'Basic realm="back\\\\slash"')
    })

    it('treats any truthy charset as the one value the RFC allows', () => {
        // "The only allowed value is UTF-8" — there is nothing else to pass,
        // so the flag is a boolean and cannot express a wrong charset.
        assert.equal(basicChallenge({ realm: 'r', charset: 1 }), 'Basic realm="r", charset="UTF-8"')
        assert.equal(basicChallenge({ realm: 'r', charset: false }), 'Basic realm="r"')
        assert.equal(basicChallenge({ realm: 'r', charset: undefined }), 'Basic realm="r"')
    })
})
