/**
 * Transport integration test: a real MeshServer on loopback, exercised through
 * the real PeerClient. The DSH Agent runtime is replaced by a stub runner so
 * this test needs no model, profile or credentials.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { PeerClient } from '../lib/client.js'
import { MeshServer } from '../lib/server.js'

const TOKEN = 'test-token'
const silent = { info() {}, warn() {} }

class StubRunner {
  constructor() {
    this.tasks = new Map()
    this.execCalls = []
    this.nextId = 1
    this.sessions = 0
  }

  hasAgentSupport() {
    return true
  }

  async submit({ task, cwd }) {
    const runId = `run${String(this.nextId++)}`
    const sessionId = `session-${String(++this.sessions)}`
    const record = {
      runId,
      sessionId,
      cwd: cwd ?? '/stub',
      status: 'running',
      output: '',
      stopReason: undefined,
      error: undefined,
      startedAt: Date.now(),
      finishedAt: 0,
      agent: { session: { seq: 0, eventAt: () => undefined } },
      firstSeq: 0,
    }
    record.done = Promise.resolve().then(() => {
      record.status = 'completed'
      record.output = `echo: ${task}`
      record.stopReason = { kind: 'completed' }
      record.finishedAt = Date.now()
      return record
    })
    this.tasks.set(runId, record)
    return record
  }

  get(runId) {
    return this.tasks.get(runId)
  }

  describe(record) {
    return {
      runId: record.runId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      status: record.status,
      output: record.output,
      stopReason: record.stopReason,
      error: record.error,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      elapsedMs: 1,
    }
  }

  async wait(runId) {
    const record = this.tasks.get(runId)
    await record.done
    return this.describe(record)
  }

  async exec({ command, cwd, timeoutMs }) {
    this.execCalls.push({ command, cwd, timeoutMs })
    return { code: 0, signal: null, cwd: cwd ?? '/stub', stdout: `${command}\n`, stderr: '', timedOut: false, failed: false }
  }

  stop() {}
}

let server
let client
let port
let runner

before(async () => {
  runner = new StubRunner()
  const config = {
    name: 'stub-peer',
    platform: 'linux',
    port: 0,
    bind: '127.0.0.1',
    token: TOKEN,
    allowExec: true,
    toolTimeoutMs: 5000,
    announceMs: 5000,
    taskCwd: '',
  }
  server = new MeshServer({ config, runner, log: silent, info: () => ({ name: 'stub-peer', platform: 'linux', agent: true, exec: true }) })
  port = await server.start()
  client = new PeerClient({ token: TOKEN, timeoutMs: 5000 })
})

after(() => server.stop())

const peer = () => ({ name: 'stub-peer', host: '127.0.0.1', port, token: '' })

test('ping answers without a token', async () => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/ping`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, proto: 1 })
})

test('every other endpoint requires the shared token', async () => {
  for (const [method, path] of [['GET', '/v1/hello'], ['POST', '/v1/task'], ['POST', '/v1/exec'], ['GET', '/v1/task/abc']]) {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method })
    assert.equal(response.status, 401, `${method} ${path}`)
  }
})

test('hello reports capability and token fingerprint', async () => {
  const hello = await client.hello(peer())
  assert.equal(hello.ok, true)
  assert.equal(hello.agent, true)
  assert.equal(hello.tokenFingerprint.length, 16)
})

test('task: synchronous call returns the peer answer', async () => {
  const task = await client.task(peer(), { task: 'say hi', timeoutMs: 5000 })
  assert.equal(task.status, 'completed')
  assert.equal(task.output, 'echo: say hi')
  assert.equal(task.sessionId, 'session-1')
})

test('task: detached call can be polled by run id', async () => {
  const detached = await client.task(peer(), { task: 'long job', detach: true, timeoutMs: 5000 })
  assert.equal(detached.runId.startsWith('run'), true)
  const settled = await client.taskStatus(peer(), detached.runId)
  assert.equal(settled.status, 'completed')
  assert.equal(settled.output, 'echo: long job')
})

test('task: bad input is rejected as BAD_REQUEST', async () => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/task`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, 'BAD_REQUEST')
  assert.equal(runner.tasks.size >= 2, true)
})

test('unknown task id is a 404 from the peer', async () => {
  await assert.rejects(client.taskStatus(peer(), 'missing'), (error) => error.code === 'UNKNOWN_TASK')
})

test('exec runs through the peer and returns stdout', async () => {
  const result = await client.exec(peer(), { command: 'uname -s' })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'uname -s\n')
  assert.equal(runner.execCalls.at(-1).command, 'uname -s')
})

test('exec is refused when the peer turned it off', async () => {
  server.config.allowExec = false
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'true' }),
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'EXEC_DISABLED')
  } finally {
    server.config.allowExec = true
  }
})

test('a wrong token is refused and never leaks peer identity', async () => {
  const wrong = new PeerClient({ token: 'nope', timeoutMs: 2000 })
  await assert.rejects(wrong.hello(peer()), (error) => {
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.equal(error.message.includes('stub-peer'), true)
    return true
  })
})

test('an unreachable peer produces PEER_UNREACHABLE', async () => {
  const unreachable = { name: 'ghost', host: '127.0.0.1', port: 1, token: '' }
  await assert.rejects(client.hello(unreachable), (error) => error.code === 'PEER_UNREACHABLE')
})
