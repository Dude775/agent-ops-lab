# OpenClaw on WSL2: two networking incidents

Environment: OpenClaw Gateway running inside a WSL2 distro (`PCMClawUbuntu`) on a Windows 11 workstation, driving Claude Code agents through the `claude-cli` backend.

| # | Incident | Visible symptom | Root cause | Fix |
|---|----------|-----------------|------------|-----|
| 1 | MCP loopback `ECONNREFUSED` | Agents ran with no tools | WSL 2.6.1 / kernel 6.6.87.2 bug with kernel-assigned (port 0) loopback listeners | `wsl --update` to 3.0.1 + `wsl --shutdown` |
| 2 | IPv6 blackhole | Telegram channel "works" but no messages arrive | Resolver prefers IPv6, IPv6 path is dead | Prefer IPv4 in `/etc/gai.conf` + gateway restart |

---

## Incident 1 - MCP loopback ECONNREFUSED

### Context

The Gateway launches Claude Code agents with `bundleMcp`: before each run it starts a loopback MCP server named `openclaw` and points the agent at it. Every run failed to connect, so the agents started without any tools.

### Symptom

- Agents answered, but could not call a single tool.
- The Gateway logs (`/tmp/openclaw/*.log`) looked clean.
- The error appeared **only in the client-side logs** of Claude Code:

```
/root/.cache/claude-cli-nodejs/*/mcp-logs-openclaw/*.jsonl
-> connect ECONNREFUSED 127.0.0.1:<port>
```

### Investigation

| Step | What I checked | Result |
|------|----------------|--------|
| 1 | `openclaw status`, `openclaw doctor` | Gateway healthy, no warnings |
| 2 | Listening sockets via `/proc/net/tcp` (`ss` not installed) | Listener present in state `0A` (LISTEN): `0100007F:B689` = `127.0.0.1:46729` |
| 3 | Running `claude` processes and their network namespaces (`readlink /proc/<pid>/ns/net`) | All share the Gateway's netns `net:[4026531840]`, so not an isolation issue |
| 4 | Gateway source: `ensureMcpLoopbackServer(port=0)` | Port is kernel-assigned (random) on every run |
| 5 | `curl` to the listener port from inside the distro | Connection refused, even though the socket is in LISTEN |
| 6 | Accept queue / `ListenOverflows` in `/proc/net/netstat` | Queue empty, no overflows |
| 7 | `/proc/net/snmp` `OutRsts` before/after a refused connect | Unchanged (`82` -> `82`) -> rejection did not come from the normal TCP RST path, consistent with a WSL-layer bug |
| 8 | `nft list ruleset` (after installing `nftables`) | Empty, no firewall rules |

### Ruled-out hypotheses

| Hypothesis | Why it was ruled out |
|------------|----------------------|
| Stale / zombie processes holding the port | Port is new on every run, and the process / netns checks showed no conflicting holder |
| Firewall | `nft` ruleset empty, traffic is loopback only |
| Memory / resource pressure | Accept queue empty, no `ListenOverflows` |

### Key experiment

Minimal repro outside OpenClaw, with a control case: same code, only the port differs.

```python
import socket, sys

port = int(sys.argv[1])  # 0 = kernel-assigned, 44444 = fixed
s = socket.socket()
s.bind(("127.0.0.1", port))
s.listen()
port = s.getsockname()[1]
print("listening on", port)

c = socket.socket()
try:
    c.connect(("127.0.0.1", port))
    print("connect OK")
except ConnectionRefusedError:
    print("connect REFUSED")
```

| Run | Result |
|-----|--------|
| `python3 repro.py 0` | `connect REFUSED` |
| `python3 repro.py 44444` | `connect OK` |
| Both again after `wsl --shutdown` | Same results, so not transient state |

This isolated the bug from OpenClaw and Node.js entirely: any listener on a kernel-assigned loopback port was unreachable.

### Root cause

A bug in WSL 2.6.1 (kernel `6.6.87.2-microsoft-standard-WSL2`) affecting connections to kernel-assigned ports on loopback. Fixed ports were not affected, which is why everything else on the box kept working.

### Fix

```powershell
wsl --version          # WSL 2.6.1, kernel 6.6.87.2
wsl --update           # -> WSL 3.0.1
wsl --shutdown
```

Verify: rerun the repro with port `0` (now `connect OK`), then start an agent run and check the client MCP log for:

```
Successfully connected to MCP server "openclaw"
```

### Gotchas

| Gotcha | Workaround |
|--------|------------|
| Git Bash rewrites Linux-style paths (e.g. `/proc/net/tcp`) into Windows paths before passing them to `wsl.exe` | Ran the checks as scripts from PowerShell. Alternative fix (not used here): `MSYS_NO_PATHCONV=1` |
| `automount` disabled in the distro, so Windows files are not visible inside WSL | Pass scripts in as base64: `wsl -d <distro> -- bash -c "echo <b64> \| base64 -d > /tmp/x.sh && bash /tmp/x.sh"` |

---

## Incident 2 - IPv6 blackhole (2026-10-16)

### Symptom

- `openclaw` channel status for Telegram reported "works".
- No messages actually arrived.
- Logs showed repeated `request-timeout` errors and the health monitor flipping to `disconnected`.

### Investigation

| Check | Result |
|-------|--------|
| `getent ahosts api.telegram.org` | IPv6 addresses returned first |
| `curl -4 -s -o /dev/null -w '%{http_code}' https://api.telegram.org` | `302` |
| `curl -6 -s -o /dev/null -w '%{http_code}' https://api.telegram.org` | `000` (no connection) |

The resolver preferred IPv6, but the IPv6 path from WSL was a blackhole. The channel status check passed, while the long-lived connection hung and timed out.

### Fix

Prefer IPv4-mapped addresses in the resolver, then restart the Gateway:

```bash
echo 'precedence ::ffff:0:0/96 100' | sudo tee -a /etc/gai.conf
getent ahosts api.telegram.org | head -3   # IPv4 now first
```

Restart the Gateway from PowerShell (or Stop/Start it in Microsoft PC Manager):

```powershell
wsl -d PCMClawUbuntu -u root -- openclaw gateway --allow-unconfigured
```

---

## Lessons

| Lesson | Applied here |
|--------|--------------|
| Read the **client-side** logs, not only the server's | The MCP error existed only in Claude Code's `mcp-logs-*` files |
| Build a minimal repro **with a control case** | Port `0` vs port `44444`, same code |
| Prove the cause before restarting things | The repro survived `wsl --shutdown`, so a restart would not have fixed it |
| One passing probe does not prove a long-lived connection works | Telegram status said "works" while the polling connection was timing out |
