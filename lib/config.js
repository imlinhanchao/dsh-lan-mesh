/**
 * Configuration resolution for the LAN mesh.
 *
 * The plugin deliberately declares no schemastery `Config` export: a
 * profile-installed bundle must not depend on packages that only resolve
 * inside the dsh installation. Every field is validated here instead, with
 * explicit defaults and human-readable errors.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform } from 'node:os'
import { join } from 'node:path'

/** Public defaults, mirrored in the README. */
export const DEFAULTS = {
  port: 7317,
  bind: '0.0.0.0',
  discoveryPort: 7318,
  announceMs: 5000,
  toolTimeoutMs: 900000,
  allowExec: true,
  server: true,
  discover: true,
  peers: [],
  taskCwd: '',
  name: '',
  token: '',
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function integer(value, fallback, min, max, label, warnings) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    warnings.push(`${label}: expected an integer in [${String(min)}, ${String(max)}], got ${JSON.stringify(value)}; using ${String(fallback)}`)
    return fallback
  }
  return parsed
}

function boolean(value, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  warnings.push(`${label}: expected a boolean, got ${JSON.stringify(value)}; using ${String(fallback)}`)
  return fallback
}

function staticPeers(value, warnings) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push('peers: expected a list of {name, host, port} entries; ignoring it')
    return []
  }
  const peers = []
  for (const entry of value) {
    if (!isObject(entry)) {
      warnings.push('peers: skipping a non-object entry')
      continue
    }
    const name = text(entry.name)
    const host = text(entry.host)
    if (name === '' || host === '') {
      warnings.push('peers: every entry needs non-empty "name" and "host"; skipping one')
      continue
    }
    const port = integer(entry.port, DEFAULTS.port, 1, 65535, `peers[${name}].port`, warnings)
    const token = text(entry.token)
    peers.push(token === '' ? { name, host, port } : { name, host, port, token })
  }
  return peers
}

/**
 * Resolve a shared secret. Order: explicit config, DSH_LAN_TOKEN, the token
 * file, then a freshly generated file (so a second machine can copy it).
 */
function resolveToken({ configured, env, home, warnings }) {
  const fromConfig = text(configured)
  if (fromConfig !== '') return { token: fromConfig, source: 'config' }

  const fromEnv = text(env.DSH_LAN_TOKEN)
  if (fromEnv !== '') return { token: fromEnv, source: 'env:DSH_LAN_TOKEN' }

  const dshHome = text(env.DSH_HOME) || join(home, '.dsh')
  const file = join(dshHome, 'lan-mesh', 'token')
  try {
    const stored = readFileSync(file, 'utf8').trim()
    if (stored !== '') return { token: stored, source: `file:${file}`, tokenFile: file }
  } catch {
    // Missing file is the normal first run.
  }

  const generated = randomBytes(24).toString('base64url')
  try {
    mkdirSync(join(dshHome, 'lan-mesh'), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${generated}\n`, { mode: 0o600 })
    warnings.push(`generated a shared token at ${file}; copy it to every machine (or set DSH_LAN_TOKEN on all of them)`)
    return { token: generated, source: `generated:${file}`, tokenFile: file }
  } catch (error) {
    warnings.push(`generated an in-memory token because ${file} is not writable (${String(error)}); peers cannot authenticate until DSH_LAN_TOKEN is set`)
    return { token: generated, source: 'memory' }
  }
}

/**
 * Resolve the row config of this plugin into a complete, validated value.
 * @param raw - the Loader row config; unknown fields are ignored.
 * @param options - injectable environment for tests.
 * @returns resolved config plus non-fatal warnings.
 */
export function resolveConfig(raw, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const warnings = []
  const config = isObject(raw) ? raw : {}

  const name = text(config.name) || text(env.DSH_LAN_NAME) || hostname() || 'dsh'
  const port = integer(config.port, DEFAULTS.port, 1, 65535, 'port', warnings)
  const bind = text(config.bind) || DEFAULTS.bind
  const discoveryPort = integer(config.discoveryPort, DEFAULTS.discoveryPort, 1, 65535, 'discoveryPort', warnings)
  const announceMs = integer(config.announceMs, DEFAULTS.announceMs, 1000, 300000, 'announceMs', warnings)
  const toolTimeoutMs = integer(config.toolTimeoutMs, DEFAULTS.toolTimeoutMs, 1000, 86400000, 'toolTimeoutMs', warnings)
  const server = boolean(config.server, DEFAULTS.server, 'server', warnings)
  const discover = boolean(config.discover, DEFAULTS.discover, 'discover', warnings)
  const allowExec = boolean(config.allowExec, DEFAULTS.allowExec, 'allowExec', warnings)
  const peers = staticPeers(config.peers, warnings)
  const taskCwd = text(config.taskCwd)
  const resolvedToken = resolveToken({ configured: config.token, env, home, warnings })

  if (discover && !server) warnings.push('discover is enabled while server is disabled: peers will announce this machine but cannot reach it')

  return {
    name,
    port,
    bind,
    discoveryPort,
    announceMs,
    toolTimeoutMs,
    server,
    discover,
    allowExec,
    peers,
    taskCwd,
    token: resolvedToken.token,
    tokenSource: resolvedToken.source,
    tokenFile: resolvedToken.tokenFile ?? '',
    platform: platform(),
    warnings,
  }
}
