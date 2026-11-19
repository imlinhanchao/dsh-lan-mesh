/**
 * Wire constants and tiny helpers shared by the LAN mesh transport.
 * No DSH packages are imported here on purpose: a profile-installed bundle
 * must load in every profile, including ones that expose only `ctx`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Protocol version carried by beacons, /v1/hello and task requests. */
export const PROTO = 1

/** Render one stack-free error message. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Short, non-reversible token fingerprint used in beacons and diagnostics. */
export function fingerprint(token) {
  if (typeof token !== 'string' || token.length === 0) return ''
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/** Stable peer identity from machine facts, so restarts do not create duplicates. */
export function peerId(name, hostname, port) {
  return createHash('sha256').update(`${name}\0${hostname}\0${port}`).digest('hex').slice(0, 12)
}

/** Random URL-safe identifier for one accepted task. */
export function newRunId() {
  return randomBytes(9).toString('base64url')
}

/** Compare two bearer tokens without early exit. */
export function tokenEquals(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Read the bearer token from an Authorization header. */
export function bearerOf(header) {
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match === null ? '' : match[1].trim()
}

/** Read and parse a bounded JSON request body. */
export async function readJsonBody(request, limitBytes = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) {
      const error = new Error('request body too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.code = 'BAD_JSON'
    throw error
  }
}

/** Write one JSON response. */
export function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Render one HTTP request as `host:port` for diagnostics. */
export function addressOf(socket) {
  if (socket === null || socket === undefined) return ''
  const address = socket.remoteAddress ?? ''
  const port = socket.remotePort ?? ''
  return `${address}:${String(port)}`
}
