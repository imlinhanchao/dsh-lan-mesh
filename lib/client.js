/**
 * Caller half of the mesh: small typed helpers over `fetch` for one peer.
 */
import { messageOf } from './protocol.js'

function hostFor(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

function codedError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

/** Combine a caller signal with a timeout signal. */
function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs))
  if (signal === undefined) return timeout
  return AbortSignal.any([signal, timeout])
}

export class PeerClient {
  constructor({ getToken, token, timeoutMs }) {
    // `getToken` keeps a live settings edit effective without reconstruction.
    this.getToken = typeof getToken === 'function' ? getToken : () => token
    this.timeoutMs = timeoutMs
  }

  endpoint(peer, path) {
    return `http://${hostFor(peer.host)}:${String(peer.port)}${path}`
  }

  /**
   * Send one authenticated request to a peer.
   * @returns parsed JSON body.
   */
  async request(peer, path, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const token = options.token !== undefined && options.token !== '' ? options.token : this.getToken()
    const signals = combineSignals(options.signal, timeoutMs)
    let response
    try {
      response = await fetch(this.endpoint(peer, path), {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...options.body === undefined ? {} : { 'content-type': 'application/json' },
          accept: 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: signals,
      })
    } catch (error) {
      if (signals.aborted) {
        const reason = signals.reason
        const timedOut = error?.name === 'TimeoutError' || reason?.name === 'TimeoutError'
        throw codedError(
          timedOut ? 'PEER_TIMEOUT' : 'PEER_ABORTED',
          timedOut
            ? `peer ${peer.name} did not answer within ${String(timeoutMs)} ms`
            : `call to peer ${peer.name} was cancelled`,
        )
      }
      throw codedError('PEER_UNREACHABLE', `cannot reach peer ${peer.name} at ${this.endpoint(peer, '')}: ${messageOf(error)}`)
    }

    let payload
    const text = await response.text()
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      throw codedError('PEER_BAD_RESPONSE', `peer ${peer.name} answered with non-JSON HTTP ${String(response.status)}: ${text.slice(0, 300)}`)
    }
    if (!response.ok) {
      const code = payload?.error?.code ?? `HTTP_${String(response.status)}`
      const message = payload?.error?.message ?? `peer ${peer.name} refused the call`
      throw codedError(code, `${peer.name}: ${message}`, { status: response.status })
    }
    return payload
  }

  /** Handshake used to verify reachability, token and capability. */
  async hello(peer, options = {}) {
    return await this.request(peer, '/v1/hello', options)
  }

  /** Start (and optionally wait for) one peer task. */
  async task(peer, { task, cwd, detach, timeoutMs, signal, token }) {
    // Leave a small margin so the peer answers before the caller's own deadline.
    const budget = Math.max(1000, (timeoutMs ?? this.timeoutMs) - 2000)
    const payload = await this.request(peer, '/v1/task', {
      method: 'POST',
      body: { task, cwd, detach: detach === true, timeoutMs: budget },
      signal,
      token,
      timeoutMs: (timeoutMs ?? this.timeoutMs) + 5000,
    })
    return payload.task
  }

  /** Read one peer task by id. */
  async taskStatus(peer, runId, options = {}) {
    const payload = await this.request(peer, `/v1/task/${encodeURIComponent(runId)}`, options)
    return payload.task
  }

  /** Run one shell command on the peer. */
  async exec(peer, { command, cwd, timeoutMs, signal, token }) {
    const payload = await this.request(peer, '/v1/exec', {
      method: 'POST',
      body: { command, cwd, timeoutMs },
      signal,
      token,
      timeoutMs: (timeoutMs ?? this.timeoutMs) + 5000,
    })
    return payload.result
  }
}
