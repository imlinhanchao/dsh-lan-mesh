/**
 * dsh-lan-mesh — call the DeepSeek Harness agents on your other home-network
 * computers as subagents.
 *
 * Every machine runs the same bundle. It exposes:
 *   - a small authenticated HTTP server that accepts tasks (`POST /v1/task`)
 *     and runs each one as a fresh, visible DSH session;
 *   - a UDP beacon so the machines discover each other without configuration;
 *   - four model-facing tools: `lan_peers`, `lan_delegate`, `lan_result`,
 *     `lan_exec`.
 *
 * The plugin imports no `@deepseek-ai/*` package: a profile-installed bundle
 * must load in any profile and on any OS using only Node built-ins and the
 * `ctx` services the host composes.
 */
import { hostname } from 'node:os'
import { PeerClient } from './lib/client.js'
import { loadConfigSchema } from './lib/config-schema.js'
import { liveValue, resolveConfig } from './lib/config.js'
import { Discovery } from './lib/discovery.js'
import { PeerRegistry } from './lib/peers.js'
import { PROTO, fingerprint, messageOf, peerId } from './lib/protocol.js'
import { TaskRunner } from './lib/runner.js'
import { MeshServer } from './lib/server.js'

export const name = 'lan-mesh'
export const inject = ['tools']

/**
 * Optional editable settings schema. When `@deepseek-ai/schemastery` resolves
 * in this deployment the Loader entry becomes a settings namespace, so
 * Settings -> Plugins -> dsh-lan-mesh -> Configure offers a form (including the
 * shared token). When it does not resolve the plugin behaves as before and
 * keeps its configuration in the profile patch file.
 */
export const Config = await loadConfigSchema()

/** Resolve a logger facade without assuming the host exposes one. */
function makeLogger(ctx) {
  try {
    const logger = ctx.logger
    if (typeof logger === 'function') {
      const named = logger(`lan-mesh`)
      if (named !== undefined && typeof named.info === 'function') return named
    }
    if (logger !== undefined && typeof logger.warn === 'function') return logger
  } catch {
    // Fall through to console.
  }
  return { info: (message) => console.log(message), warn: (message) => console.warn(message) }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000))}s`
}

function formatStopReason(reason) {
  if (reason === undefined || reason === null) return ''
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') {
    const detail = reason.error?.message
    return detail === undefined ? reason.kind : `${reason.kind}: ${detail}`
  }
  return JSON.stringify(reason)
}

function tool(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec.parameters ?? {})) {
    const { required: isRequired, ...schema } = value
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: spec.execute,
    ...spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs },
  }
}

export function apply(ctx, rawConfig) {
  const log = makeLogger(ctx)
  const config = resolveConfig(rawConfig)
  // Editable settings are volatile: read them per use so a save applies at once.
  const liveName = () => {
    const value = liveValue(rawConfig, 'name')
    const name = typeof value === 'string' ? value.trim() : ''
    return name !== '' ? name : config.name
  }
  const liveToken = () => {
    const value = liveValue(rawConfig, 'token')
    const token = typeof value === 'string' ? value.trim() : ''
    return token !== '' ? token : config.token
  }
  const liveAllowExec = () => {
    const value = liveValue(rawConfig, 'allowExec')
    return typeof value === 'boolean' ? value : config.allowExec
  }
  const liveConfig = Object.defineProperties({ ...config }, {
    name: { get: liveName, enumerable: true },
    token: { get: liveToken, enumerable: true },
    allowExec: { get: liveAllowExec, enumerable: true },
  })
  for (const warning of config.warnings) log.warn(`lan-mesh: ${warning}`)
  if (config.tokenSource.startsWith('generated:')) {
    log.warn(`lan-mesh: token file ${config.tokenSource.slice('generated:'.length)} holds the shared token; copy it to the other machines`)
  }

  const selfId = peerId(config.name, hostname(), config.port)
  const registry = new PeerRegistry({
    selfId,
    selfName: config.name,
    auth: () => fingerprint(liveToken()),
    announceMs: config.announceMs,
  })
  registry.addStatic(config.peers)

  const runner = new TaskRunner(ctx, liveConfig, log)
  const client = new PeerClient({ getToken: liveToken, timeoutMs: config.toolTimeoutMs })
  const server = new MeshServer({
    config: liveConfig,
    runner,
    log,
    info: () => ({
      name: liveName(),
      platform: config.platform,
      port: config.server ? (server.port || config.port) : 0,
      agent: runner.hasAgentSupport(),
      exec: liveAllowExec(),
      configForm: Config !== undefined,
      runtimes: ctx.get('sessionController') === undefined ? [] : ['dsh'],
    }),
  })

  const beacon = () => ({
    v: PROTO,
    id: selfId,
    name: liveName(),
    port: server.port || config.port,
    platform: config.platform,
    proto: PROTO,
  })
  const discovery = new Discovery({
    port: config.discoveryPort,
    announceMs: config.announceMs,
    auth: () => fingerprint(liveToken()),
    beacon,
    log,
    onBeacon: (payload, address) => {
      const outcome = registry.observe(payload, address)
      if (outcome.accepted && outcome.peer?.source === 'discovery') log.info(`lan-mesh: discovered peer ${outcome.peer.name} at ${address}:${String(outcome.peer.port)}`)
    },
  })

  if (config.server) {
    server.start().catch(() => {
      // MeshServer already logged the concrete bind failure.
    })
  } else {
    log.info('lan-mesh: peer server disabled by config; this machine can call peers but cannot be called')
  }
  if (config.discover) discovery.start()

  ctx.effect(() => () => {
    discovery.stop()
    server.stop()
    runner.stop()
  })

  // ---- model-facing tools -------------------------------------------------

  const describeSelf = () => {
    const where = config.server ? `http://${config.bind}:${String(server.port || config.port)}` : 'server disabled'
    return `This machine: "${liveName()}" (${config.platform}, ${where}, token fingerprint ${fingerprint(liveToken()) || 'none'})`
  }

  const peerLine = (peer) => `${peer.name}  [${peer.id}]  ${peer.platform}  http://${peer.host}:${String(peer.port)}  ${peer.source === 'static' ? 'configured' : 'discovered'}  ${peer.online ? 'online' : 'offline'}`

  /**
   * Resolve a peer, waiting one beacon period for a just-started machine so a
   * first call does not fail merely because discovery has not arrived yet.
   */
  const findPeer = async (key) => {
    const found = registry.resolve(key)
    if (found.error === undefined) return found.peer
    await registry.waitForChange(Math.min(config.announceMs, 3000))
    const retry = registry.resolve(key)
    if (retry.error !== undefined) throw new Error(retry.error)
    return retry.peer
  }

  const tokenFor = (peer) => (typeof peer.token === 'string' && peer.token !== '' ? peer.token : config.token)

  const peersTool = tool({
    name: 'lan_peers',
    description:
      'List the other computers on the home LAN that run DeepSeek Harness with the LAN mesh plugin, then probe them for reachability and capability. '
      + 'Call this before lan_delegate to learn exact peer names. A peer can be called by name or id; static peers come from configuration, discovered peers from the LAN beacon.',
    parameters: {
      probe: {
        type: 'boolean',
        description: 'Probe each peer with a short authenticated handshake. Defaults to true; pass false for an instant list.',
      },
    },
    async execute(args, exec) {
      let list = registry.list()
      if (list.length === 0) {
        // Give a just-started LAN one beacon period before saying "no peers".
        await registry.waitForChange(Math.min(config.announceMs, 3000))
        list = registry.list()
      }
      const shouldProbe = args?.probe !== false
      const lines = [describeSelf()]
      if (list.length === 0) {
        lines.push('No peers yet. Either the other machines have not started this plugin, UDP discovery is blocked by a firewall, or you can add static peers in the plugin config.')
        return lines.join('\n')
      }
      const outages = []
      for (const peer of list) {
        if (!shouldProbe || !peer.online) {
          lines.push(peerLine(peer))
          continue
        }
        try {
          const hello = await client.hello(peer, { token: tokenFor(peer), timeoutMs: 2000, signal: exec?.signal })
          registry.markSeen(peer)
          lines.push(`${peerLine(peer)}  agent=${hello.agent ? 'yes' : 'no'} exec=${hello.exec ? 'yes' : 'no'} token=${hello.tokenFingerprint === fingerprint(tokenFor(peer)) ? 'matches' : 'MISMATCH'}`)
        } catch (error) {
          outages.push(`${peer.name}: ${messageOf(error)}`)
          lines.push(`${peerLine(peer)}  unreachable`)
        }
      }
      if (outages.length > 0) lines.push(`Probe failures:\n${outages.map((line) => `  - ${line}`).join('\n')}`)
      return lines.join('\n')
    },
  })

  const delegateTool = tool({
    name: 'lan_delegate',
    timeoutMs: config.toolTimeoutMs,
    description:
      'Delegate a task to another computer on the home LAN and run it there as a subagent: the peer opens a fresh DeepSeek Harness session with its own profile, tools, model, sandbox and configuration, works on the task, and returns its final answer here. '
      + 'Use it when the task needs another operating system (for example macOS-only tooling, Xcode, Windows software), a machine-specific configuration, or hardware/network access this machine does not have. '
      + 'The remote agent cannot see this conversation, so the task must be self-contained: state the goal, relevant paths, and exactly what to report back. '
      + 'The task runs synchronously by default and can take minutes; pass detach=true to get a run id immediately and poll with lan_result. Call lan_peers first for exact peer names.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name or id from lan_peers.' },
      task: { type: 'string', required: true, description: 'Self-contained instruction for the remote DSH agent. Include all context it needs and what to report back.' },
      cwd: { type: 'string', description: 'Absolute working directory on the peer machine. Omit to use the peer profile default directory.' },
      timeout_sec: { type: 'integer', description: `How long to wait for the remote answer, in seconds. Defaults to ${String(Math.round(config.toolTimeoutMs / 1000))}.` },
      detach: { type: 'boolean', description: 'Return a run id immediately instead of waiting for the answer; read it later with lan_result.' },
    },
    async execute(args, exec) {
      const peer = await findPeer(args?.peer)
      const timeoutMs = Number.isSafeInteger(args?.timeout_sec) && args.timeout_sec > 0
        ? Math.min(args.timeout_sec * 1000, 6 * 60 * 60 * 1000)
        : config.toolTimeoutMs
      const task = await client.task(peer, {
        task: args?.task,
        cwd: typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined,
        detach: args?.detach === true,
        timeoutMs,
        signal: exec?.signal,
        token: tokenFor(peer),
      })
      const head = `[${peer.name}] ${task.status}${task.status === 'completed' ? '' : ` (session ${task.sessionId})`} in ${formatDuration(task.elapsedMs)}`
      if (args?.detach === true) {
        return `${head}\nrun id: ${task.runId}\nsession: ${task.sessionId}\nPoll with lan_result(peer="${peer.name}", run_id="${task.runId}").`
      }
      if (task.status === 'running') {
        return `${head}\nThe remote turn is still running. Partial answer so far:\n\n${task.output || '(nothing committed yet)'}\n\nCollect the rest with lan_result(peer="${peer.name}", run_id="${task.runId}").`
      }
      const parts = [head]
      const reason = formatStopReason(task.stopReason)
      if (reason !== '') parts.push(`stop reason: ${reason}`)
      if (task.error !== undefined) parts.push(`error: ${task.error}`)
      parts.push('', '--- remote answer ---', task.output === '' ? '(the remote agent returned no text)' : task.output)
      return parts.join('\n')
    },
  })

  const resultTool = tool({
    name: 'lan_result',
    description:
      'Read one detached or still-running LAN peer task by its run id. Reports the current status, elapsed time, and the answer committed so far. Use it after lan_delegate with detach=true, or to collect a task that outlived the delegation timeout.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name or id that accepted the task.' },
      run_id: { type: 'string', required: true, description: 'Run id returned by lan_delegate.' },
    },
    async execute(args, exec) {
      const peer = await findPeer(args?.peer)
      const task = await client.taskStatus(peer, args?.run_id, { token: tokenFor(peer), signal: exec?.signal })
      const parts = [`[${peer.name}] ${task.status} in ${formatDuration(task.elapsedMs)} (session ${task.sessionId})`]
      const reason = formatStopReason(task.stopReason)
      if (reason !== '') parts.push(`stop reason: ${reason}`)
      if (task.error !== undefined) parts.push(`error: ${task.error}`)
      parts.push('', '--- answer so far ---', task.output === '' ? '(nothing committed yet)' : task.output)
      return parts.join('\n')
    },
  })

  const execTool = tool({
    name: 'lan_exec',
    timeoutMs: config.toolTimeoutMs,
    description:
      'Run one shell command on another home-LAN computer through its DSH LAN mesh server and return exit code, stdout and stderr. '
      + 'This is a raw command channel for quick capability probes (system version, installed tools, reading a config value) that do not need an agent; prefer lan_delegate when the peer must reason about the work. '
      + 'The command runs with the peer user\'s permissions in a shell, so the peer machine owner must allow it (allowExec).',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name or id from lan_peers.' },
      command: { type: 'string', required: true, description: 'Shell command line to run on the peer machine.' },
      cwd: { type: 'string', description: 'Absolute working directory on the peer.' },
      timeout_sec: { type: 'integer', description: 'Command timeout in seconds. Defaults to 120.' },
    },
    async execute(args, exec) {
      const peer = await findPeer(args?.peer)
      const timeoutMs = Number.isSafeInteger(args?.timeout_sec) && args.timeout_sec > 0
        ? Math.min(args.timeout_sec * 1000, 3_600_000)
        : 120_000
      const startedAt = Date.now()
      const result = await client.exec(peer, {
        command: args?.command,
        cwd: typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined,
        timeoutMs,
        signal: exec?.signal,
        token: tokenFor(peer),
      })
      const parts = [`[${peer.name}] exit ${String(result.code ?? 'none')}${result.signal ? ` signal ${String(result.signal)}` : ''} in ${formatDuration(Date.now() - startedAt)} (limit ${formatDuration(timeoutMs)})`]
      if (result.timedOut) parts.push('(timed out and was killed)')
      if (result.truncated) parts.push('(output truncated)')
      if (result.stdout !== '') parts.push('', '--- stdout ---', result.stdout)
      if (result.stderr !== '') parts.push('', '--- stderr ---', result.stderr)
      if (result.stdout === '' && result.stderr === '') parts.push('(no output)')
      return parts.join('\n')
    },
  })

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(peersTool),
      ctx.tools.register(delegateTool),
      ctx.tools.register(resultTool),
      ctx.tools.register(execTool),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          log.warn(`lan-mesh: tool cleanup failed: ${messageOf(error)}`)
        }
      }
    }
  })

  // Tell the model which machines exist, in the prompt, so it can decide to
  // delegate without first calling a tool. Contribution is empty while no peer
  // is known, so an isolated machine pays no tokens.
  try {
    ctx.inject(['systemPrompt'], (injected) => {
      injected.effect(() => injected.get('systemPrompt').section({
        name: 'lan-mesh',
        order: 880,
        text: () => {
          const online = registry.online()
          if (online.length === 0) return ''
          const peers = online.map((peer) => `${peer.name} (${peer.platform})`).join(', ')
          return `Other computers on this LAN also run DeepSeek Harness and can be called as subagents with the lan_delegate tool: ${peers}. `
            + 'Delegate when a task needs that machine\'s operating system, installed software, hardware or configuration; pass a self-contained task and expect the remote agent to have none of this conversation.'
        },
      }))
    })
  } catch (error) {
    log.warn(`lan-mesh: cannot advertise peers in the system prompt: ${messageOf(error)}`)
  }

  log.info(`lan-mesh: ready as "${config.name}" (id ${selfId}, token ${config.tokenSource})`)
}
