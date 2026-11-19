# dsh-lan-mesh — design notes

Goal: on a home LAN, each computer runs DeepSeek Harness (`dsh`). Any agent can
delegate a task to another machine and get the answer back, so work that needs
macOS-only tooling, a Windows install, or a machine-specific configuration runs
on that machine's own DSH.

## Shape

```
   machine A (linux)                         machine B (macOS)
 ┌──────────────────────────┐             ┌──────────────────────────┐
 │ local Agent              │             │ local Agent              │
 │   │ lan_delegate         │  HTTP+token │   │                      │
 │   ▼                      │ ──────────► │   ▼                      │
 │ PeerClient ──────────────┼── POST      │ MeshServer               │
 │                          │  /v1/task   │   │ TaskRunner            │
 │ TaskRunner (server side) │ ◄────────── │   ▼                      │
 │ MeshServer               │   answer    │ sessionController.create │
 │ UDP beacon ◄─────────────┼─────────────┼──►  Agent.followup       │
 └──────────────────────────┘  discovery  └──────────────────────────┘
```

One bundle, `dsh-lan-mesh`, runs on every machine. It starts:

1. **Peer server** — a small `node:http` server (`bind:0.0.0.0:7317`) that accepts
   authenticated tasks (each in its own fresh peer Session, with no queue limit)
   and answers with the peer Agent's final text.
2. **UDP discovery** — broadcasts a JSON beacon every 5 s on udp/7318 and
   listens for peers. Beacon carries name/port/platform/protocol and a *token
   fingerprint*, never the token.
3. **Tools** for the local model: `lan_peers`, `lan_delegate`, `lan_result`,
   `lan_exec`.
4. **A system-prompt line** listing currently online peers (empty when none, so
   a lone machine pays no tokens).

## Remote task execution

A remote task is not a special sandbox. The peer calls its own
`ctx.sessionController.create({ cwd })` — the same path as pressing "New session"
in the Web GUI — then drives it exactly like the shipped headless runner:

```
agent.followup({ role:'user', content:[{type:'text', text:task}], source:{kind:'user'} })
await agent.whenIdle(); (wait for subagents too)
read turn events: last assistant/message text + turn/end reason
```

Consequences (documented for users):

- the peer session appears in that machine's GUI session list and follows its
  profile, preset, tools, sandbox, model selection and approval policy;
- the remote agent cannot see the caller's conversation, so the task must be
  self-contained;
- approvals still apply on the peer. A task that needs approval nobody answers
  will fail or stall on the peer; the caller sees the timeout / error text.

## Wire protocol (v1)

All paths except `/v1/ping` require `Authorization: Bearer <shared token>`.
JSON in, JSON out. Body limit 1 MiB.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/ping` | — | `{ ok, proto }` (unauthenticated reachability) |
| GET | `/v1/hello` | — | `{ ok, proto, name, platform, port, agent, exec, tokenFingerprint, runtimes }` |
| POST | `/v1/task` | `{ task, cwd?, timeoutMs?, detach? }` | `{ ok, task: TaskView }` |
| GET | `/v1/task/<runId>` | — | `{ ok, task: TaskView }` |
| POST | `/v1/exec` | `{ command, cwd?, timeoutMs? }` | `{ ok, result: { code, signal, cwd, stdout, stderr, truncated, timedOut } }` |

`TaskView` = `{ runId, sessionId, cwd, status: "running"|"completed"|"error", output, stopReason, error, startedAt, finishedAt, elapsedMs }`.

`detach:true` returns immediately with `status:"running"`; otherwise the request
holds until the turn ends or the request budget expires (then returns the
running task with partial output, pollable by run id).

Errors use `{ ok:false, error:{ code, message } }`. Server-side codes:
`UNAUTHORIZED` (401), `BAD_REQUEST` (400), `BAD_CWD` (400), `EXEC_DISABLED`
(403), `UNKNOWN_TASK` (404), `NOT_FOUND` (404), `NO_AGENT_RUNTIME` (503),
`AGENT_MISSING` (500), `SHUTTING_DOWN` (500), `INTERNAL` (500). Caller-side
codes produced by `lib/client.js`: `PEER_UNREACHABLE`, `PEER_TIMEOUT`,
`PEER_ABORTED`, `PEER_BAD_RESPONSE`, or the peer's own code passed through.

UDP beacon: `{ v:1, id, name, port, platform, proto, auth }`, where `auth` is
`sha256(token)` hex truncated to 16 chars. Beacons with a different fingerprint,
or from this instance's own id, are ignored.

## Configuration (Loader row config)

| Key | Default | Meaning |
|---|---|---|
| `name` | `os.hostname()`, then `DSH_LAN_NAME` | peer name shown to the other machines; an empty `DSH_LAN_NAME` is ignored |
| `port` | `7317` | peer server TCP port |
| `bind` | `0.0.0.0` | peer server bind address |
| `server` | `true` | run the peer server (disable for a caller-only machine) |
| `discover` | `true` | UDP announce/listen |
| `discoveryPort` | `7318` | UDP discovery port |
| `announceMs` | `5000` | beacon period; peers expire after 3 periods |
| `token` | see below | shared secret; every machine must use the same one |
| `peers` | `[]` | static `{ name, host, port, token? }` entries for subnets/firewalls; a per-peer `token` overrides the shared token for every call to that peer, and the configured `host`/`port` stay authoritative (a same-name beacon cannot redirect them) |
| `taskCwd` | `""` | default directory for remote tasks on this machine |
| `toolTimeoutMs` | `900000` | `lan_delegate` / `lan_exec` tool deadline |
| `allowExec` | `true` | accept `/v1/exec` raw commands on this machine |

Token resolution order: `config.token` → `DSH_LAN_TOKEN` → `<DSH_HOME>/lan-mesh/token`
(generated with mode 0600 on first run) → in-memory (warning). `lan_peers`
prints the fingerprint so the machines can be compared.

## Settings page

The bundle declares `Config` so its Loader entry becomes a settings namespace, and
its browser half registers the bundle row's page in the Plugins sidebar
(`plugins.row.config`, key `dsh-lan-mesh#lan-mesh`) so the row gets a **Configure**
control. The page edits three fields: `name`, `token`, `allowExec`.

Two facts drive the implementation:

- The settings service only projects `.volatile()` fields into an editable form.
  Ordinary fields would be invisible there. The three editable fields are
  therefore volatile; every other field stays validated-but-YAML-only.
- A volatile field arrives as an accessor (`{ get() }`), and its value changes in
  place when the settings page saves. The plugin reads them through `liveValue`
  on every use (server auth, beacon fingerprint, caller token, `lan_exec` gate,
  displayed name), so a save re-announces and re-authenticates immediately with
  no plugin remount and no process restart. Ports and `discover` cannot work that
  way — they rebind sockets — which is why they stay in the profile patch.

`lib/config-schema.js` resolves `@deepseek-ai/schemastery` through
`DSH_PROFILE_DIR`, `DSH_HOME/profiles/<profile>`, and the bundle's own location.
When no route resolves, `Config` is `undefined`: the row keeps working exactly as
before, `/v1/hello` reports `configForm:false`, and the page explains that the
configuration lives in the profile patch.

Verified against a scratch profile with a real browser: the page rendered, a save
wrote `token` and `allowExec` into the profile patch, and the running peer
switched token fingerprint and `exec` capability without a restart.

## Security model

- LAN only. Plain HTTP by design; the token is the whole access control.
- A machine's token holder can run agent turns and (if `allowExec`) shell
  commands as that machine's user. Treat the token like an SSH key; keep UDP
  discovery off untrusted networks or set `discover:false` + static peers.
- Discovery never carries the secret; only a fingerprint used to filter foreign
  beacons.
- No public exposure, no relay, no account: nothing leaves the LAN. Do not port
  forward the peer port.

## Files

| File | Role |
|---|---|
| `index.js` | plugin entry: config, server/discovery wiring, tools, prompt line |
| `lib/config.js` | validated config + token resolution |
| `lib/protocol.js` | wire constants, token compare, JSON body helpers |
| `lib/peers.js` | static + discovered peer registry, name resolution |
| `lib/discovery.js` | UDP broadcast/listen |
| `lib/server.js` | peer HTTP server and endpoints |
| `lib/runner.js` | task execution on the peer (Agent drive, final text, exec) |
| `lib/client.js` | caller-side authenticated fetch |
| `lib/config-schema.js` | optional `Config` schema (schemastery, resolved through the Host) |
| `client.js` | browser half: the Plugins page row settings form |
| `docs/settings-page.png` | screenshot of that form |
| `test/unit.test.mjs` | config/peers/protocol/extract tests |
| `test/server.test.mjs` | real MeshServer + PeerClient over loopback |
| `test/plugin.test.mjs` | `apply()` wiring under a fake Host context |

Tests: `node --test test/unit.test.mjs test/server.test.mjs test/plugin.test.mjs`
(30 tests, no model or credentials needed).

## Manual verification

```sh
# Shared token: config -> DSH_LAN_TOKEN -> <DSH_HOME>/lan-mesh/token
TOKEN=$(cat ~/.dsh/lan-mesh/token)   # when it was auto-generated
# 1. peer is alive
curl -s http://127.0.0.1:7317/v1/ping
# 2. authenticated handshake
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7317/v1/hello
# 3. raw command
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"command":"uname -a"}' http://127.0.0.1:7317/v1/exec
# 4. real agent task on the peer (costs one model turn)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"task":"Reply with exactly: LAN-MESH-OK","timeoutMs":180000}' http://127.0.0.1:7317/v1/task
```

From a local Agent the same flow is `lan_peers` → `lan_delegate`.
