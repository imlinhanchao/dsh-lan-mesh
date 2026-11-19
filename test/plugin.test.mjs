/**
 * Plugin-entry test: mounts `apply()` against a minimal fake Cordis context
 * with no DSH services, so tool registration, the peer server, discovery
 * options, the system-prompt contribution and the tool output formatting are
 * exercised without a profile, model or credentials.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { apply } from '../index.js'

const TOKEN = 'plugin-entry-token'
const PORT = 17431

/** Minimal stand-in for the Cordis context the Host passes to a plugin. */
function fakeContext() {
  const services = new Map()
  const tools = []
  const sections = []
  const logs = []
  const disposers = []
  const logger = (name) => ({
    info: (message) => logs.push(`info ${name ? `${name}:` : ''} ${String(message)}`),
    warn: (message) => logs.push(`warn ${String(message)}`),
  })
  const context = {
    logger,
    get: (name) => services.get(name),
    on: () => () => {},
    inject(deps, callback) {
      const injected = {
        get: (name) => (name === 'systemPrompt' ? { section: (definition) => { sections.push(definition); return () => {} } } : services.get(name)),
        effect: (fn) => { disposers.push(fn()) },
      }
      callback(injected)
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
    services,
    toolsList: tools,
    sections,
    logs,
    disposeAll: () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Cleanup failures do not fail this harness.
        }
      }
    },
  }
  return context
}

const ctx = fakeContext()
apply(ctx, { name: 'plugin-entry-peer', port: PORT, bind: '127.0.0.1', token: TOKEN, discover: false, allowExec: false })

async function waitForServer(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ctx.logs.some((line) => line.includes('peer server listening'))) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`peer server did not start; logs:\n${ctx.logs.join('\n')}`)
}

after(() => ctx.disposeAll())

test('plugin entry registers the four tools with usable schemas', () => {
  const names = ctx.toolsList.map((definition) => definition.name)
  assert.deepEqual(names.sort(), ['lan_delegate', 'lan_exec', 'lan_peers', 'lan_result'])
  for (const definition of ctx.toolsList) {
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.deepEqual(definition.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }])
  }
  const delegate = ctx.toolsList.find((definition) => definition.name === 'lan_delegate')
  assert.deepEqual(delegate.parameters.required.sort(), ['peer', 'task'])
  assert.equal(delegate.parameters.properties.timeout_sec.type, 'integer')
  assert.equal(typeof delegate.timeoutMs, 'number')
})

test('plugin entry contributes a system-prompt section that is empty without peers', () => {
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'lan-mesh')
  assert.equal(ctx.sections[0].text(), '')
})

test('peer server starts from the row config with the expected handshake', async () => {
  await waitForServer()
  const health = await fetch(`http://127.0.0.1:${String(PORT)}/v1/ping`)
  assert.deepEqual(await health.json(), { ok: true, proto: 1 })
  const hello = await fetch(`http://127.0.0.1:${String(PORT)}/v1/hello`, { headers: { authorization: `Bearer ${TOKEN}` } })
  const body = await hello.json()
  assert.equal(body.name, 'plugin-entry-peer')
  assert.equal(body.agent, false, 'no sessionController in this fake context')
  assert.equal(body.exec, false, 'allowExec:false')
  assert.equal(body.tokenFingerprint.length, 16)
})

test('lan_peers without a peer reports the machine identity after a short grace wait', async () => {
  const peers = ctx.toolsList.find((definition) => definition.name === 'lan_peers')
  const started = Date.now()
  const text = await peers.execute({}, { signal: AbortSignal.timeout(10_000) })
  assert.match(text, /This machine: "plugin-entry-peer"/)
  assert.match(text, /No peers yet/)
  // A first call waits at most one (short) announce period before answering.
  assert.equal(Date.now() - started >= 200, true)
})

test('lan_delegate with an unknown peer gives an actionable error', async () => {
  const delegate = ctx.toolsList.find((definition) => definition.name === 'lan_delegate')
  await assert.rejects(delegate.execute({ peer: 'ghost', task: 'hello' }, {}), (error) => {
    assert.match(error.message, /unknown peer "ghost"/)
    assert.match(error.message, /known peers/)
    return true
  })
})

test('lan_result with an unknown peer is rejected before any call', async () => {
  const result = ctx.toolsList.find((definition) => definition.name === 'lan_result')
  await assert.rejects(result.execute({ peer: 'ghost', run_id: 'x' }, {}), /unknown peer/)
})
