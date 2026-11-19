# dsh-lan-mesh setup

Step-by-step installation of the `dsh-lan-mesh` bundle on macOS, Windows and Linux, including token sharing, firewall rules, static peers for networks that block broadcast, and a two-machine verification procedure.

For what the plugin does, its tools and its security model, read [../README.md](../README.md) first.

## Before you start

Do this on **every** machine that should take part in the mesh:

- [ ] DeepSeek Harness is installed and starts (`dsh web` works, or the Desktop app opens).
- [ ] You know which profile runs DSH. The examples use `web` (the Web app). The Desktop app uses `desktop` and must have been opened once so its profile exists. A headless profile can be a caller or answer `lan_exec`, but it cannot run delegated agent tasks.
- [ ] The `dsh-lan-mesh` bundle directory exists on the machine. It is a normal directory, not an npm package from a registry; copy it there (USB stick, `scp`, file share) and use its absolute path.
- [ ] The machine is on the same LAN as the others. For automatic discovery it must share a broadcast domain; otherwise you will add static peers.
- [ ] TCP 7317 and UDP 7318 are free (or you have chosen different ports).

Machine names and example addresses used in this guide:

| Machine | OS | Example LAN address | Profile | Example bundle path |
|---|---|---|---|---|
| mac-mini | macOS | `192.168.1.10` | `web` | `/Users/you/Downloads/dsh-lan-mesh` |
| linux-box | Linux | `192.168.1.20` | `web` | `/home/you/dsh-lan-mesh` |
| win-pc | Windows | `192.168.1.30` | `web` | `C:\Users\you\dsh-lan-mesh` |

Replace the addresses with the real ones on your network.

## Step 1: Install the bundle

Run this on every machine. It adds the bundle to the profile's dependency list **and** to its `dsh.profile.bundles` list. Install from a directory you intend to keep: the profile records the dependency against that path, so moving or deleting the bundle directory later breaks the bundle on the next start.

### macOS and Linux

```sh
# 1. Quit DSH first (Ctrl-C in the terminal that runs `dsh web`, or quit the Desktop app).
# 2. Install from the absolute bundle directory (macOS example).
dsh plugin --profile web add /Users/you/Downloads/dsh-lan-mesh
# Linux example:
# dsh plugin --profile web add /home/you/dsh-lan-mesh

# 3. Start DSH again
dsh web
```

### Windows

Use PowerShell or Command Prompt:

```powershell
# 1. Quit DSH (close the Desktop app or stop `dsh web`).
# 2. Install from the absolute bundle directory.
dsh plugin --profile web add C:\Users\you\dsh-lan-mesh

# 3. Start DSH again
dsh web
```

For the Desktop app, use `--profile desktop` instead of `--profile web`; open the app once so its profile exists, fully quit it, then run the install command.

### Check that it loaded

The DSH log should contain lines like these shortly after startup:

```
lan-mesh: ready as "mac-mini" (id 4f2a9c1b7e33, token generated:/Users/you/.dsh/lan-mesh/token)
lan-mesh: peer server listening on http://0.0.0.0:7317 as "mac-mini"
lan-mesh: discovery listening on udp/7318, announcing to 255.255.255.255, 192.168.1.255
```

- `ready as` proves the profile loaded the bundle.
- `peer server listening` proves TCP is bound.
- `discovery listening` proves UDP is bound. A warning here usually means the UDP socket could not start (port blocked or used exclusively).

You can also verify the profile files directly. In `<DSH_HOME>/profiles/web/` (default `~/.dsh/profiles/web` or `%USERPROFILE%\.dsh\profiles\web`):

- `package.json` contains `dsh-lan-mesh` in `dependencies` and in `dsh.profile.bundles`;
- `cordis.patch.yml` may contain your `lan-mesh` row (optional — defaults work without it).

If the log has no `lan-mesh:` lines, the bundle row is not active. Re-run the install command, make sure the profile name is right, and restart DSH.

> The same bundle must be installed on every machine. A machine that does not run it cannot be discovered and cannot be called.

## Step 2: Share one token

The simple setup is the **same** shared token on every machine. On first run each machine generates its own random token, so freshly installed machines cannot authenticate each other until you make the tokens equal — or you give static peer entries their own `token` (see [Step 4](#step-4-static-peers-optional)).

Pick one machine as the source (for example mac-mini) and read its token.

### Read the token

**macOS / Linux**

```sh
# DSH_HOME defaults to ~/.dsh; if you set DSH_HOME, this follows it.
cat "${DSH_HOME:-$HOME/.dsh}/lan-mesh/token"
```

**Windows (PowerShell)**

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
Get-Content (Join-Path $dshHome "lan-mesh\token")
```

If that file does not exist, either the plugin has not started yet or one of the other sources is already configured. Look for `token: ...` in the `lan-mesh` row of `profiles/<profile>/cordis.patch.yml`, or check `DSH_LAN_TOKEN` in the environment of the DSH process. The startup log names the winning source: `token config`, `token env:DSH_LAN_TOKEN`, `token file:<path>`, `token generated:<path>` or `token memory`.

### Install the token on the other machines (three options)

Choose one option and use it on **all** other machines.

**Option A — copy the token file (simplest).** Put the exact string in `<DSH_HOME>/lan-mesh/token`.

macOS / Linux:

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/lan-mesh"
printf '%s\n' 'PASTE_THE_TOKEN_HERE' > "${DSH_HOME:-$HOME/.dsh}/lan-mesh/token"
chmod 600 "${DSH_HOME:-$HOME/.dsh}/lan-mesh/token"
chmod 700 "${DSH_HOME:-$HOME/.dsh}/lan-mesh"
```

Windows PowerShell:

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$dir = Join-Path $dshHome "lan-mesh"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -NoNewline -Path (Join-Path $dir "token") -Value 'PASTE_THE_TOKEN_HERE'
```

**Option B — the `DSH_LAN_TOKEN` environment variable.** This overrides the token file; in the simple setup it holds the same value on every machine. Set it in the environment that launches DSH — a shell export does not reach the macOS/Windows Desktop app launched from Finder or the Start menu.

```sh
# macOS/Linux shell profile, then restart the terminal and DSH
export DSH_LAN_TOKEN='PASTE_THE_TOKEN_HERE'
```

```powershell
# Windows, user-wide; sign out/in or restart the app afterwards
[Environment]::SetEnvironmentVariable('DSH_LAN_TOKEN', 'PASTE_THE_TOKEN_HERE', 'User')
```

**Option C — the `token` config key.** Put it in the `lan-mesh` row of the profile patch file, `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: lan-mesh
  name: dsh-lan-mesh
  config:
    token: PASTE_THE_TOKEN_HERE
```

A `token` in config wins over the environment variable and over the token file.

### Restart and compare fingerprints

Restart DSH on every machine whose token changed, then compare. The easiest check is `lan_peers` in each machine's DSH session: the first output line contains the machine's token fingerprint, `token fingerprint <16 hex characters>`. All machines must show the same 16 characters.

You can also compute the fingerprint locally:

```sh
# macOS
printf %s "$TOKEN" | shasum -a 256 | cut -c1-16
# Linux
printf %s "$TOKEN" | sha256sum | cut -c1-16
```

```powershell
# Windows PowerShell
$t = 'PASTE_THE_TOKEN_HERE'
$b = [Text.Encoding]::UTF8.GetBytes($t)
[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-','').ToLower().Substring(0,16)
```

The fingerprint is a one-way hash prefix: it lets you compare tokens without printing them, and it is the only token-related value discovery beacons ever carry.

> Order matters when diagnosing: `config.token` → `DSH_LAN_TOKEN` → `<DSH_HOME>/lan-mesh/token` → random in-memory token. A stale environment variable can silently override a correct token file.

## Step 3: Firewall

The peer needs inbound **TCP on 7317** and inbound **UDP on 7318** from the other LAN machines. Outbound traffic is normally allowed already.

### Windows

Run these in an **elevated** Command Prompt or PowerShell (Administrator):

```bat
netsh advfirewall firewall add rule name="DSH LAN mesh" dir=in action=allow protocol=TCP localport=7317
netsh advfirewall firewall add rule name="DSH LAN mesh" dir=in action=allow protocol=UDP localport=7318
```

To limit the rules to private/home networks (recommended on laptops that also join public Wi-Fi):

```bat
netsh advfirewall firewall add rule name="DSH LAN mesh" dir=in action=allow protocol=TCP localport=7317 profile=private
netsh advfirewall firewall add rule name="DSH LAN mesh" dir=in action=allow protocol=UDP localport=7318 profile=private
```

Remove them again with:

```bat
netsh advfirewall firewall delete rule name="DSH LAN mesh"
```

Also allow the DSH/Node process if Windows Defender Firewall shows the “Allow access” prompt on first start. Check the rules:

```bat
netsh advfirewall firewall show rule name="DSH LAN mesh"
```

### macOS

1. The first time the peer server listens, macOS shows **“Do you want the application `node` to accept incoming network connections?”** — click **Allow**.
2. If you missed the prompt, open **System Settings → Network → Firewall → Options…** and allow the `node` (or `dsh`) application. If the firewall is off entirely, no prompt appears and no rule is needed.
3. On macOS 14/15, also allow **Local Network** access for the terminal app or the Desktop app if macOS asks (System Settings → Privacy & Security → Local Network). Without it, discovery and connections to other machines are blocked.

Check the firewall state:

```sh
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```

No `netsh`-style rule is required when the application is allowed.

### Linux

`ufw` (Ubuntu/Debian):

```sh
sudo ufw allow 7317/tcp comment 'DSH LAN mesh peer'
sudo ufw allow 7318/udp comment 'DSH LAN mesh discovery'
sudo ufw status verbose
```

`firewalld` (Fedora/RHEL/Arch with firewalld):

```sh
sudo firewall-cmd --add-port=7317/tcp --add-port=7318/udp          # runtime
sudo firewall-cmd --permanent --add-port=7317/tcp --add-port=7318/udp
sudo firewall-cmd --reload
```

`nftables`/`iptables`: allow `tcp dport 7317` and `udp dport 7318` on the LAN interface; a common quick rule is `iifname "eth0" tcp dport 7317 accept` plus the UDP equivalent.

If DSH runs as a systemd service, remember that its environment (including `DSH_HOME` and `DSH_LAN_TOKEN`) comes from the unit file, not from your login shell. The token file under the service user's `DSH_HOME` is usually simpler.

## Step 4: Static peers (optional)

Automatic discovery uses UDP broadcast, which does not cross routers, VLANs, subnets, VPNs, VM NAT or Wi-Fi networks with client isolation. In those cases list the peers explicitly. Static peers are always shown as online and every call still authenticates with the shared token or the peer's own `token` if you set one.

Edit `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` on each machine. The profile patch targets the bundle's row by id (`lan-mesh`); put this machine's settings under `config`.

**mac-mini** (`/Users/you/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: lan-mesh
  name: dsh-lan-mesh
  config:
    name: mac-mini
    token: PASTE_THE_TOKEN_HERE
    discover: false
    peers:
      - name: linux-box
        host: 192.168.1.20
        port: 7317
      - name: win-pc
        host: 192.168.1.30
        port: 7317
```

**linux-box** (`/home/you/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: lan-mesh
  name: dsh-lan-mesh
  config:
    name: linux-box
    token: PASTE_THE_TOKEN_HERE
    discover: false
    peers:
      - name: mac-mini
        host: 192.168.1.10
        port: 7317
      - name: win-pc
        host: 192.168.1.30
        port: 7317
```

**win-pc** (`C:\Users\you\.dsh\profiles\web\cordis.patch.yml`):

```yaml
- id: lan-mesh
  name: dsh-lan-mesh
  config:
    name: win-pc
    token: PASTE_THE_TOKEN_HERE
    discover: false
    peers:
      - name: mac-mini
        host: 192.168.1.10
        port: 7317
      - name: linux-box
        host: 192.168.1.20
        port: 7317
```

Notes:

- Use each machine's actual LAN address (the one the other machines can reach). On Windows, `ipconfig`; on macOS/Linux, `ip addr` / `ifconfig`.
- `port` defaults to 7317 inside a peer entry, so it can be omitted if you kept the default.
- `discover: false` is optional. If you leave discovery on, a beacon with the same name is absorbed into the static entry so you see one peer instead of two; the configured host/port always win (the beacon only marks the peer online and adds its platform/protocol), so a beacon from a different address cannot redirect calls and a wrong configured address fails loudly on the first call.
- Each machine needs entries for the others (or a mix of static and discovered peers).
- A peer entry may carry its own `token`; it overrides the shared token for every call to that peer (handshake, `lan_delegate`, `lan_result`, `lan_exec`). Using one shared token on every machine is the simple default.
- Restart DSH after editing the YAML. A malformed number or entry produces a warning in the log and falls back to the default.

## Step 5: Verify two machines

Use mac-mini (`192.168.1.10`) and linux-box (`192.168.1.20`); substitute your real addresses. Run each numbered check in order and stop at the first failure, then see [Troubleshooting](#troubleshooting-quick-reference).

### 1. Local peer server on each machine

```sh
curl -s http://127.0.0.1:7317/v1/ping
```

Expected: `{"ok":true,"proto":1}`. This endpoint needs no token. A connection error means the plugin is not running, the port is different, or it is bound to another address (check `bind`).

### 2. Authenticated handshake on each machine

```sh
TOKEN=$(cat "${DSH_HOME:-$HOME/.dsh}/lan-mesh/token")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7317/v1/hello
```

Expected: a JSON object with `"ok":true`, the machine's `name`, `platform`, `port`, `"agent":true`, `"exec":true`, `"runtimes":["dsh"]`, and a 16-character `tokenFingerprint`. In this shared-token setup the two machines must report the **same** `tokenFingerprint`; if you deliberately gave a static peer its own `token`, compare each `tokenFingerprint` with the token configured for that peer instead.

Windows equivalent:

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$token = (Get-Content (Join-Path $dshHome "lan-mesh\token") -Raw).Trim()
curl.exe -s -H "Authorization: Bearer $token" http://127.0.0.1:7317/v1/hello
```

From mac-mini, the same two checks against linux-box (replace `127.0.0.1` with the peer's address; from linux-box, use mac-mini's address instead):

```sh
curl -s --connect-timeout 3 http://192.168.1.20:7317/v1/ping
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.1.20:7317/v1/hello
```

A `401` here means the tokens differ; a timeout means TCP 7317 is blocked or the address is wrong.

### 3. `lan_peers` from a DSH session

On mac-mini, ask its agent:

> Call `lan_peers` and tell me which machines are online and whether they support delegated tasks.

Expected lines:

```
This machine: "mac-mini" (darwin, http://0.0.0.0:7317, token fingerprint 3f786850e387550f)
linux-box  [7d1f0c2a9b44]  linux  http://192.168.1.20:7317  discovered  online  agent=yes exec=yes token=matches
```

`agent=yes` means the peer can run delegated sessions (Web/Desktop profile). `exec=yes` means `allowExec` is on. If the peer is listed but the probe says `unreachable`, see [Troubleshooting](#troubleshooting-quick-reference).

Run `lan_peers` on linux-box too: mac-mini should appear there. Both directions matter — a firewall may allow one direction and not the other.

### 4. `lan_exec` cross-machine

On mac-mini:

> Use `lan_exec` on `linux-box` to run `uname -a` and show the output.

Expected: exit code `0` and Linux kernel output. From linux-box to mac-mini, use `sw_vers` instead. On Windows, `ver`.

### 5. `lan_delegate` cross-machine

On mac-mini:

> Delegate to `linux-box`: reply with exactly `LAN-MESH-OK` and nothing else.

Expected: `completed`, with `LAN-MESH-OK` as the remote answer. On linux-box's Web/Desktop GUI session list a new session should have appeared for the task. Delegation costs one model turn on the peer.

Also test the detached mode:

> Delegate to `linux-box` with detach, ask it to reply with exactly `LAN-MESH-OK`.

Expected: an immediate run id and session id. Then:

> Check `lan_result` for peer `linux-box`, run id `<id>`.

Expected: `completed` with the answer (or `running` and partial output if it is still working — poll again).

### 6. Negative check

From the shell, call the peer **without** a token and confirm it is refused:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.20:7317/v1/hello
```

Expected: `401`. If this returns `200`, you are not talking to a mesh peer that requires a token — stop and investigate.

### 7. Firewall check for discovery

Watch each machine's log. `discovery listening on udp/7318, announcing to ...` proves the socket is up, and `discovered peer <name> at <address>:<port>` lines (about every 5 seconds per non-static peer) prove that broadcast and the token fingerprint match. If no `discovered peer` lines appear but the static peers work, broadcast is blocked somewhere — that is not an error, static peers are the supported workaround.

If you completed all seven checks, the mesh is working in both directions.

## Step 6: Stop, disable, uninstall

- **Stop the mesh temporarily:** quit DSH, or disable the `lan-mesh` bundle in the plugin manager, then restart.
- **Uninstall:** `dsh plugin --profile web remove dsh-lan-mesh` (use your profile name), then restart DSH.
- **Rotate the token:** set the new value in config/env/file on every machine, restart DSH everywhere. Until all machines restart, discovery and authentication are split — some peers disappear or return 401.
- **Delete the token file:** `<DSH_HOME>/lan-mesh/token` is not removed by uninstalling. Delete it if you want the secret gone.
- **Uninstall firewall rules:** `netsh advfirewall firewall delete rule name="DSH LAN mesh"` (Windows), `sudo ufw delete allow 7317/tcp` / `sudo ufw delete allow 7318/udp` (ufw), `sudo firewall-cmd --permanent --remove-port=7317/tcp --remove-port=7318/udp && sudo firewall-cmd --reload` (firewalld).

## Troubleshooting quick reference

| Symptom | Most likely cause | Fix |
|---|---|---|
| `lan_peers`: “No peers yet” | Plugin not loaded, tokens differ, UDP blocked, or different subnet | Check the `lan-mesh:` startup log lines; compare token fingerprints; open UDP 7318; add static peers |
| Peer listed but probe says `unreachable` | TCP 7317 blocked by a firewall, wrong host/port, or the peer process is down | Open TCP 7317; check the address; check the peer's log |
| `401` / `UNAUTHORIZED` | Different token on the two machines, or an environment variable overriding the token file | Compare fingerprints via `lan_peers`; check config → `DSH_LAN_TOKEN` → token file order; restart DSH |
| `NO_AGENT_RUNTIME` / `agent=no` | The receiving machine runs a non-Web/Desktop profile | Run its DSH with the `web` or `desktop` profile |
| `lan_delegate` returns partial text plus a run id | The remote turn is still running | Poll `lan_result`; use `detach: true` for long tasks |
| `UNKNOWN_TASK` | Run id expired (2 hours) or DSH restarted | Re-submit the task |
| `BAD_CWD` | `cwd` does not exist on the peer | Use an absolute path that exists there, or omit `cwd` |
| `EXEC_DISABLED` | Peer has `allowExec: false` | Enable it on the peer or use `lan_delegate` |
| `peer server cannot start ... EADDRINUSE` | Another DSH/process owns TCP 7317 | Stop it or set a different `port` on one instance |
| Two entries for the same machine | The peer's name/host/port changed (its id is derived from them) | Wait 10 minutes for the stale entry to drop, or restart DSH |
| Desktop app cannot find the token | Desktop app does not inherit shell environment variables | Put the token in the config/token file instead of `DSH_LAN_TOKEN`, and restart the app |

For fuller explanations see [../README.md#troubleshooting](../README.md#troubleshooting).
