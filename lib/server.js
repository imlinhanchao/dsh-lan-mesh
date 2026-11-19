/**
 * Peer HTTP server: the receiving half of the mesh.
 *
 * Plain HTTP on the LAN is intentional: traffic never leaves the home network,
 * and the only credential is the shared token. Every endpoint except the
 * reachability ping requires that token.
 */
import { createServer } from 'node:http'
import { PROTO, addressOf, bearerOf, fingerprint, messageOf, readJsonBody, sendJson, tokenEquals } from './protocol.js'

const MAX_WAIT_MS = 6 * 60 * 60 * 1000

function errorBody(code, message) {
  return { ok: false, error: { code, message } }
}

function statusFor(code) {
  switch (code) {
    case 'UNAUTHORIZED': return 401
    case 'EXEC_DISABLED': return 403
    case 'UNKNOWN_TASK': return 404
    case 'BAD_REQUEST':
    case 'BAD_CWD': return 400
    case 'NO_AGENT_RUNTIME': return 503
    default: return 500
  }
}

export class MeshServer {
  /**
   * @param options.config - resolved plugin config.
   * @param options.runner - TaskRunner for this process.
   * @param options.log - logger with `.warn`/`.info`.
   * @param options.info - `()` to describe this instance for /v1/hello.
   */
  constructor({ config, runner, log, info }) {
    this.config = config
    this.runner = runner
    this.log = log
    this.info = info
    this.server = null
    this.port = 0
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          this.log.warn(`lan-mesh: request failed: ${messageOf(error)}`)
          if (!response.headersSent) sendJson(response, 500, errorBody('INTERNAL', messageOf(error)))
          else response.end()
        })
      })
      server.on('error', (error) => {
        this.log.warn(`lan-mesh: peer server cannot start on ${this.config.bind}:${String(this.config.port)}: ${messageOf(error)}`)
        reject(error)
      })
      server.listen(this.config.port, this.config.bind, () => {
        this.server = server
        this.port = server.address().port
        this.log.info(`lan-mesh: peer server listening on http://${this.config.bind}:${String(this.port)} as "${this.config.name}"`)
        resolve(this.port)
      })
    })
  }

  stop() {
    const server = this.server
    this.server = null
    if (server === null) return
    try {
      server.close()
    } catch {
      // Already closed.
    }
  }

  authorized(request) {
    if (this.config.token === '') return false
    return tokenEquals(bearerOf(request.headers.authorization), this.config.token)
  }

  async handle(request, response) {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://peer.invalid')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    // Unauthenticated reachability probe: no identity, no capability data.
    if (path === '/v1/ping') {
      sendJson(response, 200, { ok: true, proto: PROTO })
      return
    }

    if (!this.authorized(request)) {
      this.log.warn(`lan-mesh: rejected ${method} ${path} from ${addressOf(request.socket)} (bad or missing token)`)
      sendJson(response, 401, errorBody('UNAUTHORIZED', 'missing or invalid bearer token; set the same token on every machine'))
      return
    }

    if (path === '/v1/hello' && method === 'GET') {
      sendJson(response, 200, { ok: true, proto: PROTO, tokenFingerprint: fingerprint(this.config.token), ...this.info() })
      return
    }

    if (path === '/v1/task' && method === 'POST') {
      await this.handleTask(request, response)
      return
    }

    const taskMatch = /^\/v1\/task\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (taskMatch !== null && method === 'GET') {
      const record = this.runner.get(taskMatch[1])
      if (record === undefined) {
        sendJson(response, 404, errorBody('UNKNOWN_TASK', `no task named ${taskMatch[1]} on this peer`))
        return
      }
      sendJson(response, 200, { ok: true, task: this.runner.describe(record) })
      return
    }

    if (path === '/v1/exec' && method === 'POST') {
      await this.handleExec(request, response)
      return
    }

    sendJson(response, 404, errorBody('NOT_FOUND', `unknown endpoint ${method} ${path}`))
  }

  async handleTask(request, response) {
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, errorBody('BAD_REQUEST', messageOf(error)))
      return
    }
    if (typeof body !== 'object' || body === null) {
      sendJson(response, 400, errorBody('BAD_REQUEST', 'request body must be a JSON object'))
      return
    }
    if (typeof body.task !== 'string' || body.task.trim() === '') {
      sendJson(response, 400, errorBody('BAD_REQUEST', 'task must be a non-empty string'))
      return
    }
    if (body.cwd !== undefined && typeof body.cwd !== 'string') {
      sendJson(response, 400, errorBody('BAD_REQUEST', 'cwd must be a string when present'))
      return
    }
    const requestedTimeout = Number.isSafeInteger(body.timeoutMs) ? body.timeoutMs : 30 * 60 * 1000
    const waitMs = Math.min(Math.max(requestedTimeout, 1000), MAX_WAIT_MS)
    try {
      const record = await this.runner.submit({
        task: body.task,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      })
      this.log.info(`lan-mesh: accepted task ${record.runId} -> session ${record.sessionId} (${record.cwd})`)
      if (body.detach === true) {
        sendJson(response, 200, { ok: true, task: this.runner.describe(record) })
        return
      }
      const settled = await this.runner.wait(record.runId, waitMs, undefined)
      sendJson(response, 200, { ok: true, task: settled })
    } catch (error) {
      const code = error?.code ?? 'INTERNAL'
      sendJson(response, statusFor(code), errorBody(code, messageOf(error)))
    }
  }

  async handleExec(request, response) {
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, errorBody('BAD_REQUEST', messageOf(error)))
      return
    }
    if (typeof body !== 'object' || body === null) {
      sendJson(response, 400, errorBody('BAD_REQUEST', 'request body must be a JSON object'))
      return
    }
    if (!this.config.allowExec) {
      sendJson(response, 403, errorBody('EXEC_DISABLED', 'remote command execution is disabled on this peer (allowExec: false)'))
      return
    }
    try {
      const result = await this.runner.exec({
        command: body.command,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        timeoutMs: Number.isSafeInteger(body.timeoutMs) ? body.timeoutMs : undefined,
      })
      this.log.info(`lan-mesh: exec from ${addressOf(request.socket)} -> exit ${String(result.code)}`)
      sendJson(response, 200, { ok: true, result })
    } catch (error) {
      const code = error?.code ?? 'INTERNAL'
      sendJson(response, statusFor(code), errorBody(code, messageOf(error)))
    }
  }
}
