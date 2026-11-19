/**
 * Peer registry: one place that merges beacons from LAN discovery with
 * statically configured peers.
 *
 * Discovery is a convenience, never an authority: a beacon only introduces a
 * name, an address and a port. Every actual call still authenticates with the
 * shared token.
 */
import { fingerprint } from './protocol.js'

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export class PeerRegistry {
  /**
   * @param options.selfId - this instance's stable id, filtered out of beacons.
   * @param options.selfName - this instance's display name.
   * @param options.token - shared token used to recognize same-token beacons.
   * @param options.announceMs - beacon period, used to expire discovered peers.
   */
  constructor({ selfId, selfName, token, announceMs }) {
    this.selfId = selfId
    this.selfName = selfName
    this.announceMs = announceMs
    this.auth = fingerprint(token)
    /** @type {Map<string, object>} keyed by peer id */
    this.peers = new Map()
    /** @type {Set<() => void>} one-shot resolvers waiting for a peer change */
    this.waiters = new Set()
  }

  /** Wake every caller waiting for a peer list change. */
  notify() {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }

  /**
   * Wait for the next accepted beacon, so a just-started peer is not reported
   * missing on the first call. Resolves `true` on a change, `false` on timeout.
   */
  waitForChange(timeoutMs) {
    if (this.waiters.size > 64) return Promise.resolve(false)
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  /** Register statically configured peers; they survive beacon expiry. */
  addStatic(entries) {
    for (const entry of entries) {
      const id = `static:${entry.name}`
      const record = {
        id,
        name: entry.name,
        host: entry.host,
        port: entry.port,
        platform: 'unknown',
        proto: 0,
        source: 'static',
        token: entry.token ?? '',
        online: true,
        verified: false,
        lastSeen: 0,
      }
      // A configured peer with the same name wins over a previously observed
      // beacon, keeping the user's chosen address authoritative.
      for (const [key, peer] of this.peers) {
        if (peer.source !== 'static' && normalizeName(peer.name) === normalizeName(entry.name)) this.peers.delete(key)
      }
      this.peers.set(id, record)
    }
  }

  /**
   * Account for one received beacon.
   * @param beacon - decoded beacon payload.
   * @param address - UDP source address (the authoritative host).
   * @returns `{ accepted, reason? }`
   */
  observe(beacon, address) {
    if (typeof beacon !== 'object' || beacon === null) return { accepted: false, reason: 'malformed beacon' }
    if (beacon.id === this.selfId) return { accepted: false, reason: 'self' }
    const name = typeof beacon.name === 'string' ? beacon.name.trim() : ''
    const port = Number(beacon.port)
    if (name === '' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return { accepted: false, reason: 'beacon without name or port' }
    }
    if (this.auth !== '') {
      if (typeof beacon.auth !== 'string' || beacon.auth !== this.auth) {
        return { accepted: false, reason: 'token fingerprint mismatch' }
      }
    }
    const now = Date.now()
    const host = typeof address === 'string' ? address : ''

    // A statically configured entry under the same name absorbs the beacon so
    // the user never sees the same machine twice. The configured host/port stay
    // authoritative: the beacon only proves that the machine is alive and adds
    // descriptive facts. A wrong configured address therefore fails loudly on
    // the first call instead of being silently redirected by a beacon.
    for (const peer of this.peers.values()) {
      if (peer.source === 'static' && normalizeName(peer.name) === normalizeName(name)) {
        peer.platform = typeof beacon.platform === 'string' ? beacon.platform : peer.platform
        peer.proto = Number(beacon.proto) || peer.proto
        peer.observedHost = host
        peer.online = true
        peer.verified = true
        peer.lastSeen = now
        this.notify()
        return { accepted: true, peer }
      }
    }

    const id = typeof beacon.id === 'string' && beacon.id !== '' ? beacon.id : `seen:${name}`
    const existing = this.peers.get(id)
    const record = {
      id,
      name,
      host: host || (existing?.host ?? ''),
      port,
      platform: typeof beacon.platform === 'string' ? beacon.platform : 'unknown',
      proto: Number(beacon.proto) || 0,
      source: 'discovery',
      token: '',
      online: true,
      verified: true,
      lastSeen: now,
    }
    this.peers.set(id, record)
    this.notify()
    return { accepted: true, peer: record }
  }

  /** Expire discovered beacons that stopped announcing. */
  prune(now = Date.now()) {
    const cutoff = this.announceMs * 3
    for (const [key, peer] of this.peers) {
      if (peer.source === 'static') {
        peer.online = true
        continue
      }
      const fresh = now - peer.lastSeen <= cutoff
      peer.online = fresh
      if (!fresh && now - peer.lastSeen > 10 * 60 * 1000) this.peers.delete(key)
    }
  }

  list(now = Date.now()) {
    this.prune(now)
    return [...this.peers.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  online(now = Date.now()) {
    return this.list(now).filter((peer) => peer.online)
  }

  /**
   * Find one peer by id, exact name, or unique case-insensitive name prefix.
   * @returns `{ peer }` or `{ error }` with a helpful message.
   */
  resolve(key) {
    const wanted = normalizeName(key)
    if (wanted === '') return { error: 'peer name is required; call lan_peers to list peers' }
    const all = this.list()
    const exactId = all.find((peer) => peer.id === key)
    if (exactId !== undefined) return { peer: exactId }
    const exactName = all.filter((peer) => normalizeName(peer.name) === wanted)
    if (exactName.length === 1) return { peer: exactName[0] }
    if (exactName.length > 1) return { error: `peer name "${key}" is ambiguous; use an id: ${exactName.map((peer) => peer.id).join(', ')}` }
    const prefixed = all.filter((peer) => normalizeName(peer.name).startsWith(wanted))
    if (prefixed.length === 1) return { peer: prefixed[0] }
    if (prefixed.length > 1) return { error: `peer name "${key}" matches several peers; use a longer name or an id: ${prefixed.map((peer) => peer.name).join(', ')}` }
    const names = all.map((peer) => peer.name).join(', ') || '(none discovered yet)'
    return { error: `unknown peer "${key}"; known peers: ${names}` }
  }

  /** Mark one peer as verified/reachable after a successful handshake. */
  markSeen(peer, now = Date.now()) {
    const record = this.peers.get(peer.id)
    if (record === undefined) return
    record.online = true
    record.verified = true
    record.lastSeen = now
  }
}
