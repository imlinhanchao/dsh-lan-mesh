import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveConfig, DEFAULTS } from '../lib/config.js'
import { PeerRegistry } from '../lib/peers.js'
import { bearerOf, fingerprint, peerId, tokenEquals } from '../lib/protocol.js'
import { extractFinalOutput } from '../lib/runner.js'

const silent = { info() {}, warn() {} }

test('config: defaults use host name and generated token file', () => {
  const home = mkdtempSync(join(tmpdir(), 'lan-mesh-'))
  const config = resolveConfig({}, { env: {}, home })
  assert.equal(config.port, DEFAULTS.port)
  assert.equal(config.discoveryPort, DEFAULTS.discoveryPort)
  assert.equal(config.name.length > 0, true)
  assert.equal(config.token.length > 0, true)
  assert.match(config.tokenSource, /^generated:/)
  assert.equal(readFileSync(config.tokenFile, 'utf8').trim(), config.token)
  // A second boot reuses the same token.
  const again = resolveConfig({}, { env: {}, home })
  assert.equal(again.token, config.token)
})

test('config: explicit token and env token win over the file', () => {
  const home = mkdtempSync(join(tmpdir(), 'lan-mesh-'))
  assert.equal(resolveConfig({ token: 'from-config' }, { env: {}, home }).tokenSource, 'config')
  assert.equal(resolveConfig({}, { env: { DSH_LAN_TOKEN: 'from-env' }, home }).token, 'from-env')
  assert.equal(resolveConfig({ token: 'a' }, { env: { DSH_LAN_TOKEN: 'b' }, home }).token, 'a')
})

test('config: tolerated mistakes produce warnings instead of crashes', () => {
  const home = mkdtempSync(join(tmpdir(), 'lan-mesh-'))
  const config = resolveConfig({ port: 'nope', peers: [{ name: 'mac', host: '' }] }, { env: {}, home })
  assert.equal(config.port, DEFAULTS.port)
  assert.equal(config.peers.length, 0)
  assert.equal(config.warnings.length >= 2, true)
})

test('config: static peers validate port and keep per-peer tokens', () => {
  const home = mkdtempSync(join(tmpdir(), 'lan-mesh-'))
  const config = resolveConfig({ token: 't', peers: [{ name: 'mac', host: '10.0.0.2', port: '9000', token: 'other' }] }, { env: {}, home })
  assert.deepEqual(config.peers, [{ name: 'mac', host: '10.0.0.2', port: 9000, token: 'other' }])
})

test('protocol: fingerprint is stable and non-reversible, token compare is exact', () => {
  assert.equal(fingerprint('secret'), fingerprint('secret'))
  assert.notEqual(fingerprint('secret'), fingerprint('secret2'))
  assert.equal(fingerprint('secret').includes('secret'), false)
  assert.equal(tokenEquals('abc', 'abc'), true)
  assert.equal(tokenEquals('abc', 'abd'), false)
  assert.equal(tokenEquals('abc', 'abcd'), false)
  assert.equal(bearerOf('Bearer xyz'), 'xyz')
  assert.equal(bearerOf('bearer  xyz '), 'xyz')
  assert.equal(bearerOf(undefined), '')
})

test('peers: discovery filters self, foreign tokens and malformed beacons', () => {
  const token = 'shared'
  const auth = fingerprint(token)
  const registry = new PeerRegistry({ selfId: 'me', selfName: 'me', token, announceMs: 1000 })
  assert.equal(registry.observe({ id: 'me', name: 'x', port: 1, auth }, '10.0.0.2').reason, 'self')
  assert.equal(registry.observe({ id: 'p1', name: 'x', port: 1, auth: 'wrong' }, '10.0.0.2').accepted, false)
  assert.equal(registry.observe({ id: 'p2', name: '', port: 1, auth }, '10.0.0.2').accepted, false)
  const ok = registry.observe({ id: 'p3', name: 'mac-mini', port: 7317, platform: 'darwin', auth }, '10.0.0.3')
  assert.equal(ok.accepted, true)
  const peer = registry.resolve('mac').peer
  assert.equal(peer.host, '10.0.0.3')
  assert.equal(peer.platform, 'darwin')
  assert.equal(registry.online().length, 1)
})

test('peers: a configured address stays authoritative over a beacon', () => {
  const registry = new PeerRegistry({ selfId: 'me', selfName: 'me', token: 't', announceMs: 1000 })
  registry.addStatic([{ name: 'mac-mini', host: '192.168.1.9', port: 7317 }])
  registry.observe({ id: 'other', name: 'mac-mini', port: 9999, auth: fingerprint('t') }, '10.9.9.9')
  const peer = registry.resolve('mac-mini').peer
  assert.equal(peer.host, '192.168.1.9')
  assert.equal(peer.port, 7317)
  assert.equal(peer.observedHost, '10.9.9.9')
  assert.equal(peer.online, true)
})

test('peers: configured peers absorb beacons with the same name', () => {
  const registry = new PeerRegistry({ selfId: 'me', selfName: 'me', token: 't', announceMs: 1000 })
  registry.addStatic([{ name: 'mac-mini', host: '192.168.1.9', port: 7317 }])
  const before = registry.resolve('mac-mini').peer
  assert.equal(before.source, 'static')
  registry.observe({ id: 'other', name: 'mac-mini', port: 7317, auth: fingerprint('t') }, '192.168.1.9')
  const after = registry.resolve('mac-mini').peer
  assert.equal(after.id, before.id)
  assert.equal(after.online, true)
  assert.equal(registry.list().length, 1)
})

test('peers: expiry and helpful resolve errors', () => {
  const registry = new PeerRegistry({ selfId: 'me', selfName: 'me', token: 't', announceMs: 100 })
  registry.observe({ id: 'p1', name: 'legacy-pc', port: 7317, auth: fingerprint('t') }, '10.0.0.4')
  assert.equal(registry.list(0).length, 1)
  assert.equal(registry.online(now()).length, 1)
  assert.match(registry.resolve('nope').error, /unknown peer/)
  const stale = registry.list(Date.now() + 10_000)
  assert.equal(stale[0].online, false)
})

test('peers: ambiguous prefix is rejected with the candidates', () => {
  const registry = new PeerRegistry({ selfId: 'me', selfName: 'me', token: 't', announceMs: 10_000 })
  registry.observe({ id: 'a', name: 'mac-mini', port: 7317, auth: fingerprint('t') }, '10.0.0.5')
  registry.observe({ id: 'b', name: 'mac-studio', port: 7317, auth: fingerprint('t') }, '10.0.0.6')
  assert.match(registry.resolve('mac').error, /matches several/)
  assert.equal(registry.resolve('mac-mini').peer.id, 'a')
})

test('runner: final assistant text and stop reason are read from the turn range', () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', seq: 1 },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'first draft' }] } } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }] } } },
    { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } },
  ]
  const session = { seq: events.length, eventAt: (seq) => events[seq] }
  const result = extractFinalOutput(session, 0)
  assert.equal(result.text, 'final answer')
  assert.equal(result.reason.kind, 'completed')
  // Earlier turns are ignored: a new prompt at seq 4 sees no assistant text yet.
  assert.equal(extractFinalOutput({ ...session, seq: 4 }, 4).text, '')
})

test('peerId is stable for the same machine facts', () => {
  assert.equal(peerId('a', 'host', 7317), peerId('a', 'host', 7317))
  assert.notEqual(peerId('a', 'host', 7317), peerId('b', 'host', 7317))
})

function now() {
  return Date.now() + 150
}
