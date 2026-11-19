/**
 * Task execution on the peer machine.
 *
 * A remote task is a normal, visible DeepSeek Harness session created through
 * `ctx.sessionController` (the same service the Web GUI uses), driven with one
 * user message and stopped when the Agent is idle again. That means the peer
 * applies its own profile, tools, sandbox, model selection and approval policy
 * instead of a special remote-only sandbox.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { messageOf, newRunId } from './protocol.js'

const MAX_CAPTURE = 512 * 1024
const TASK_RETENTION_MS = 2 * 60 * 60 * 1000
const TASK_RECORDS = 100

/**
 * Read the final assistant text and terminal reason of one turn range,
 * mirroring how the shipped headless runner summarizes a one-shot run.
 * @param session - live Session of the peer Agent.
 * @param firstSeq - sequence where the remote prompt was submitted.
 */
export function extractFinalOutput(session, firstSeq) {
  let started = false
  let text = ''
  let reason
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) break
    if (event.type === 'turn/start') {
      started = true
      reason = undefined
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function truncate(value) {
  if (value.length <= MAX_CAPTURE) return { text: value, truncated: false }
  return { text: value.slice(0, MAX_CAPTURE), truncated: true }
}

export class TaskRunner {
  /**
   * @param ctx - the plugin Host context.
   * @param config - resolved plugin config.
   * @param log - logger with `.warn`/`.info`.
   */
  constructor(ctx, config, log) {
    this.ctx = ctx
    this.config = config
    this.log = log
    /** @type {Map<string, object>} */
    this.tasks = new Map()
    this.closed = false
  }

  /** Whether this profile can create an Agent (Web/Desktop profiles can). */
  hasAgentSupport() {
    return this.ctx.get('sessionController') !== undefined && this.ctx.get('agents') !== undefined
  }

  /** Resolve the directory a remote task should run in. */
  resolveCwd(requested) {
    const candidate = typeof requested === 'string' && requested.trim() !== ''
      ? requested.trim()
      : this.config.taskCwd !== ''
        ? this.config.taskCwd
        : (this.ctx.get('workingDirectory')?.defaultDirectory ?? process.cwd())
    if (typeof candidate !== 'string' || candidate.trim() === '') return process.cwd()
    const absolute = resolvePath(candidate)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      throw codedError('BAD_CWD', `working directory does not exist on the peer: ${absolute}`)
    }
    if (!stats.isDirectory()) throw codedError('BAD_CWD', `working directory is not a directory on the peer: ${absolute}`)
    return absolute
  }

  /**
   * Create the peer Session, submit the prompt and start driving the turn.
   * Resolves as soon as the turn is submitted, so callers can either wait for
   * completion or return a run id immediately.
   */
  async submit({ task, cwd }) {
    if (this.closed) throw codedError('SHUTTING_DOWN', 'the LAN mesh plugin is shutting down')
    if (typeof task !== 'string' || task.trim() === '') throw codedError('BAD_REQUEST', 'task must be a non-empty string')
    if (task.length > 200_000) throw codedError('BAD_REQUEST', 'task is too long (200000 characters max)')
    if (!this.hasAgentSupport()) {
      throw codedError(
        'NO_AGENT_RUNTIME',
        'this DSH profile cannot create an Agent (it is not a Web/Desktop profile); run the peer through a GUI profile that composes sessionController',
      )
    }
    const controller = this.ctx.get('sessionController')
    const agents = this.ctx.get('agents')
    const directory = this.resolveCwd(cwd)
    const created = await controller.create({ cwd: directory })
    const sessionId = String(created.sessionId)
    const agent = await this.waitForAgent(agents, sessionId)
    await agent.whenIdle()

    const runId = newRunId()
    const record = {
      runId,
      sessionId,
      cwd: directory,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: 0,
      output: '',
      stopReason: undefined,
      error: undefined,
      agent,
      firstSeq: agent.session.seq,
    }
    this.tasks.set(runId, record)
    this.prune()
    record.done = this.drive(agent, task)
      .then((result) => {
        record.status = result.status
        record.output = result.output
        record.stopReason = result.stopReason
        record.error = result.error
        record.finishedAt = Date.now()
        return record
      })
      .catch((error) => {
        record.status = 'error'
        record.error = messageOf(error)
        record.finishedAt = Date.now()
        return record
      })
    // The turn runs in the background; waiters attach through `wait`.
    record.done.catch(() => {})
    return record
  }

  async waitForAgent(agents, sessionId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const agent = agents.get(sessionId)
      if (agent !== undefined) return agent
      if (Date.now() > deadline) throw codedError('AGENT_MISSING', `the peer created Session ${sessionId} but its Agent did not become available`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  async drive(agent, task) {
    const firstSeq = agent.session.seq
    let failure
    const stopError = this.ctx.on?.('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) failure = { error, atOffset: agent.session.seq }
    })
    const stopTerminal = this.ctx.on?.('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end' && failure !== undefined && event.seq >= failure.atOffset) failure = undefined
    })
    try {
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      }
      agent.followup(message)
      const subagents = this.ctx.get('subagents')
      // Finish the turn and any children it started; idle alone is not enough.
      for (;;) {
        await agent.whenIdle()
        const idleSeq = agent.session.seq
        const joined = await subagents?.waitForChildren(agent)
        if (!joined && agent.status === 'idle' && agent.session.seq === idleSeq) break
      }
    } finally {
      stopError?.()
      stopTerminal?.()
    }
    const { text, reason } = extractFinalOutput(agent.session, firstSeq)
    if (failure !== undefined) {
      return { status: 'error', output: text, stopReason: reason, error: messageOf(failure.error) }
    }
    const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined
    return {
      status: kind === 'error' ? 'error' : 'completed',
      output: text,
      stopReason: reason,
      error: kind === 'error' ? (reason?.error?.message ?? 'the peer turn failed') : undefined,
    }
  }

  /** Read one task record, or `undefined` when it is unknown/expired. */
  get(runId) {
    const record = this.tasks.get(runId)
    if (record === undefined) return undefined
    return record
  }

  /**
   * Await a task, up to `timeoutMs`. A still-running task is returned as
   * `status: 'running'` together with its current partial output.
   */
  async wait(runId, timeoutMs, signal) {
    const record = this.get(runId)
    if (record === undefined) throw codedError('UNKNOWN_TASK', `no task named ${runId} on this peer (it may have expired)`)
    if (record.status !== 'running') return this.describe(record)
    let timer
    let aborted
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs))
    })
    const onAbort = () => abortResolve?.('aborted')
    let abortResolve
    const abort = new Promise((resolve) => { abortResolve = resolve })
    if (signal !== undefined) {
      if (signal.aborted) return this.describe(record)
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const outcome = await Promise.race([record.done.then(() => 'done'), timeout, abort])
      return this.describe(record)
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /** JSON-safe projection of one record for the wire. */
  describe(record) {
    const snapshot = this.snapshot(record)
    return {
      runId: snapshot.runId,
      sessionId: snapshot.sessionId,
      cwd: snapshot.cwd,
      status: snapshot.status,
      output: snapshot.output,
      stopReason: snapshot.stopReason,
      error: snapshot.error,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      elapsedMs: (snapshot.finishedAt || Date.now()) - snapshot.startedAt,
    }
  }

  /** Project one record, reading partial output from the live Session while it runs. */
  snapshot(record) {
    if (record.status !== 'running' || record.agent === undefined) return record
    let output = ''
    let stopReason
    try {
      const extracted = extractFinalOutput(record.agent.session, record.firstSeq)
      output = extracted.text
      stopReason = extracted.reason
    } catch {
      // A Session mid-write may be unreadable for one instant; the next poll succeeds.
    }
    return { ...record, output, stopReason }
  }

  /** Run one shell command on the peer and capture its output. */
  async exec({ command, cwd, timeoutMs }) {
    if (!this.config.allowExec) throw codedError('EXEC_DISABLED', 'remote command execution is disabled on this peer (allowExec: false)')
    if (typeof command !== 'string' || command.trim() === '') throw codedError('BAD_REQUEST', 'command must be a non-empty string')
    if (command.length > 100_000) throw codedError('BAD_REQUEST', 'command is too long')
    const directory = this.resolveCwd(cwd)
    const limit = Number.isSafeInteger(timeoutMs) ? Math.min(Math.max(timeoutMs, 1000), 3_600_000) : 120_000
    return await new Promise((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd: directory,
        env: { ...process.env, DSH_LAN_MESH: '1' },
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, limit)
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, signal: null, cwd: directory, stdout: '', stderr: messageOf(error), timedOut, failed: true })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const out = truncate(stdout)
        const err = truncate(stderr)
        resolve({
          code,
          signal,
          cwd: directory,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          timedOut,
          failed: false,
        })
      })
    })
  }

  prune(now = Date.now()) {
    for (const [runId, record] of this.tasks) {
      if (record.status !== 'running' && now - record.finishedAt > TASK_RETENTION_MS) this.tasks.delete(runId)
    }
    while (this.tasks.size > TASK_RECORDS) {
      const oldest = this.tasks.keys().next().value
      if (oldest === undefined) break
      if (this.tasks.get(oldest)?.status === 'running') break
      this.tasks.delete(oldest)
    }
  }

  stop() {
    this.closed = true
    this.tasks.clear()
  }
}
