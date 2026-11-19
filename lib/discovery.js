/**
 * UDP LAN discovery.
 *
 * Each instance broadcasts a small JSON beacon every `announceMs` on the
 * discovery port, and listens for the beacons of the others. The beacon never
 * carries the shared token, only its short fingerprint, so a foreign program on
 * the LAN cannot use discovery to learn the secret.
 */
import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { PROTO, fingerprint, messageOf } from './protocol.js'

/** Compute every IPv4 broadcast address of this machine (subnet directed). */
export function broadcastAddresses() {
  const addresses = new Set(['255.255.255.255'])
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      const broadcast = ip.map((byte, index) => (byte | (~mask[index] & 0xff)) & 0xff)
      addresses.add(broadcast.join('.'))
    }
  }
  return [...addresses]
}

export class Discovery {
  /**
   * @param options.port - UDP discovery port shared by every machine.
   * @param options.announceMs - beacon period.
   * @param options.beacon - function returning the beacon payload.
   * @param options.onBeacon - `(payload, address) => void` for accepted payloads.
   * @param options.log - logger with `.warn`/`.info`.
   */
  constructor({ port, announceMs, beacon, auth, onBeacon, log }) {
    this.port = port
    this.announceMs = announceMs
    this.beacon = beacon
    // A function, so a live settings edit changes the beacon fingerprint at once.
    this.auth = typeof auth === 'function' ? auth : () => fingerprint(auth)
    this.onBeacon = onBeacon
    this.log = log
    this.socket = null
    this.timer = null
    this.targets = []
    this.warned = new Set()
    this.stopped = false
  }

  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (buffer, info) => {
      let payload
      try {
        payload = JSON.parse(buffer.toString('utf8'))
      } catch {
        return
      }
      try {
        this.onBeacon(payload, info.address)
      } catch (error) {
        this.log.warn(`lan-mesh: beacon handler failed: ${messageOf(error)}`)
      }
    })
    socket.on('error', (error) => {
      this.log.warn(`lan-mesh: UDP discovery stopped: ${messageOf(error)}`)
      this.stop()
    })
    socket.bind({ port: this.port, address: '0.0.0.0', exclusive: false }, () => {
      if (this.stopped) return
      try {
        socket.setBroadcast(true)
      } catch (error) {
        this.log.warn(`lan-mesh: cannot enable UDP broadcast: ${messageOf(error)}`)
      }
      this.targets = broadcastAddresses()
      this.log.info(`lan-mesh: discovery listening on udp/${this.port}, announcing to ${this.targets.join(', ')}`)
      this.announce()
      this.timer = setInterval(() => this.announce(), this.announceMs)
      this.timer.unref?.()
    })
  }

  announce() {
    if (this.stopped || this.socket === null) return
    // The beacon payload carries no secret: only the token fingerprint.
    const payload = Buffer.from(JSON.stringify({ ...this.beacon(), auth: this.auth() }))
    for (const target of this.targets) {
      this.socket.send(payload, this.port, target, (error) => {
        if (error === undefined || error === null) return
        // Some hosts refuse broadcast through a firewall rule; say so once per
        // target instead of hiding it or repeating it every announce period.
        if (this.warned.has(target)) return
        this.warned.add(target)
        this.log.warn(`lan-mesh: beacon to ${target}:${String(this.port)} failed (${messageOf(error)}); use static peers if discovery stays empty`)
      })
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
  }
}
