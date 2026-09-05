

// True when `ip` is a loopback address. Handles all three forms:
//   - IPv4: anything in 127.0.0.0/8
//   - IPv6: ::1
//   - IPv4-mapped-in-IPv6: ::ffff:127.x.y.z (what dual-stack stacks return)
//
// Used by mikser's auth middleware to honor the "loopback connections are
// trusted; non-loopback connections must authenticate" rule across plugins.
// Pass `req.ip` rather than `req.socket.remoteAddress` — Express's req.ip
// walks `X-Forwarded-For` when trust proxy is configured, which is what
// reveals the real client through a properly-configured reverse proxy.
export function isLoopback(ip) {
    if (!ip || typeof ip !== 'string') return false
    const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip
    if (addr === '::1') return true
    if (addr === '127.0.0.1') return true
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
}

// Express middleware factory: 403s any request whose `req.ip` isn't
// loopback. Plugins use this to protect routes that should be reachable
// only from the local machine. Customize the response with `message`.
//
// For more nuanced policies (token gate + loopback fallback), plugins
// usually inline the check using isLoopback() directly — this factory is
// for the simple "this route is local-only, period" case.
export function loopbackOnly({ message = 'Endpoint accepts loopback connections only.' } = {}) {
    return (req, res, next) => {
        if (isLoopback(req.ip)) return next()
        res.status(403).json({ error: message })
    }
}
