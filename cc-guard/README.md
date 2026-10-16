# cc-guard - egress and destruction guard for Claude Code on Windows

A `PreToolUse` hook that reads every `Bash` / `PowerShell` command Claude Code is
about to run and blocks it (exit 2) when it matches a rule: network egress,
destructive filesystem or git operations, secret access, persistence, defense
evasion, encoded payloads.

**Why it exists:** a `permissions.deny` list in `settings.json` is prefix-based.
These all pass a typical deny list:

| Bypass | Deny list result |
|---|---|
| `python -c "import requests; ..."` | allowed |
| `Invoke-WebRequest https://...` | allowed |
| `node -e "fetch(...)"` | allowed |
| `Remove-Item -LiteralPath X -Recurse` | allowed (unless a separate rule exists) |
| `cat ~/.ssh/id_rsa` (a Read deny only covers the Read tool) | allowed |

A `PreToolUse` hook sees the **whole command string**, so it closes all of them.
Unlike the deny list, it also holds when the agent runs with
`--permission-mode bypassPermissions`.

## Files

| File | Purpose |
|---|---|
| `cc-guard.ps1` | the hook (v3.4). Reads hook JSON on stdin, denies on match with exit 2 |
| `cc-guard-test.ps1` | 130 cases: 79 must-DENY, 51 must-ALLOW (counted by the script) |
| `README.md` | this file |

## Install

1. Copy the hook:

   ```powershell
   Copy-Item .\cc-guard.ps1 "$env:USERPROFILE\.claude\hooks\cc-guard.ps1"
   ```

2. Register it in `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash|PowerShell",
           "hooks": [
             {
               "type": "command",
               "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<you>\\.claude\\hooks\\cc-guard.ps1\"",
               "timeout": 15
             }
           ]
         }
       ]
     },
     "env": { "CC_GUARD_MODE": "warn" }
   }
   ```

3. Run the tests (they force enforce mode and use a temp log, so your real log
   and allow file are untouched):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\cc-guard-test.ps1
   # must print: ALL 130 CASES PASS
   ```

4. Check enforcement in the mode agents actually use:

   ```powershell
   claude -p --permission-mode bypassPermissions "run exactly this and nothing else: curl https://example.com"
   ```

   Expected: denied, with `BLOCKED by cc-guard` and the rule id in the reason.

5. Run a day in `warn`, read `~/.claude/cc-guard.log` for false positives, then
   set `CC_GUARD_MODE` to `enforce`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CC_GUARD_MODE` | `enforce` | `warn` logs matches but never blocks |
| `CC_GUARD_LOG` | `~/.claude/cc-guard.log` | log path (rotated to `.1` above 5MB) |
| `CC_GUARD_ALLOW` | `~/.claude/cc-guard-allow.txt` | approved one-off exceptions |
| `CC_GUARD_DENY_EXTRA` | *(empty)* | comma-separated site-specific names to deny |

### Site-specific names: `CC_GUARD_DENY_EXTRA`

The source ships with **generic** secret patterns only: `.env` / `.env.*`,
`id_rsa`, `id_ed25519`, `.ssh/`, `.aws/`, `.npmrc`, `.netrc`, `*.pem`, `*.key`,
`*.pfx`, `credentials*`. Names that only exist on your machine (a vault folder,
a key file, an API-key file name) do not belong in the repo. Put them in the
environment instead:

```json
"env": { "CC_GUARD_DENY_EXTRA": "my-vault,team-keys,prod-api-key.txt" }
```

Each entry is matched literally (regex-escaped) and case-insensitively anywhere
in the command, under rule id `SEC-PATH-EXTRA`. Empty entries are ignored.

### Approved exceptions: `cc-guard-allow.txt`

- One literal substring per line, owned by the user.
- A command that matches a rule AND contains a listed substring is allowed and
  logged as `APPROVED <rules> ...`.
- Lines shorter than **8 characters are ignored**, so an entry like `rm` or
  `curl` can never open a whole rule. Use a specific path.
- Empty the file when the job is done.
- It only affects cc-guard. It does not override `permissions.deny`.

## Version history

- **v2** - fixed three false positives: `-Encoding utf8` (ENCODED-PAYLOAD),
  `process.env` / `settings.env` (SEC-PATH), `python -m pip install requests` (NET-PYTHON).
- **v3** - the v2 fix was a regression: anchoring `rm` / `curl` to start-of-command
  let every wrapper through (`timeout 30 curl`, `env curl`, `bash -c "curl ..."`,
  `xargs rm -rf`, `find -exec rm -rf`, `sudo rm -rf`). Fix: stop enumerating what
  may precede the command; a negative lookbehind excludes only safe prefixes.
- **v3.1** - caught `curl.exe`, `wget.exe`, full-path `curl.exe`, `/usr/bin/curl`,
  `/bin/rm -rf`, `rm --recursive --force`, `"rm" -rf`; stopped denying `git -C <dir> rm`.
- **v3.2** - `NET-CLI` needs a target-shaped token after the tool (flag, URL,
  variable, domain, `localhost`, `user@host:`, IP), so `git commit -m "fix curl timeout"`
  passes. Git exclusion for `rm` only within one `git ... rm` invocation. Allow
  file and log rotation added.
- **v3.3** - from the warn log: plain `rm -f file` is allowed; `-r` / `--recursive`
  and `rm -f` on a glob stay denied. New `FS-RM-BULK` for `xargs rm -f` /
  `find -exec rm -f`.
- **v3.4** - public release. Secret rules reduced to generic patterns, `*.key`
  and `credentials*` added, site-specific names moved to `CC_GUARD_DENY_EXTRA`.
  Test harness isolates mode, log, allow file and extra names.

## Honest limits

- **Not a sandbox.** It matches the command string. A command that builds the
  payload at runtime can slip through. A tripwire, not a boundary.
- **`python exfil.py` is not caught.** A script file that opens a socket never
  names the module on the command line. `import subprocess` in a `-c` one-liner is.
- **`docker rm -rf` is allowed by design.** `docker|podman|nerdctl|kubectl|git`
  are whitelisted prefixes so normal container work passes.
- **Fail-open on internal error.** A crash exits 0 so a broken hook cannot brick
  every shell command. Keep `permissions.deny` as the second layer.
- **The log is plain text.** Do not put secrets in commands you expect logged.
- **`ssh` / `scp` are blocked entirely.** Use the allow file for a specific host.
- **Variable indirection passes:** `c=curl; $c https://x`.
- **`git commit -m "fix curl https://x"` is denied** (word + URL in one string).
- **Words trip the secret rules.** `grep -r secret`, or a folder named
  `secret-something` listed with `ls`, is denied by `SEC-ENUM`.

## Rollback

Remove the `cc-guard` entry from `hooks.PreToolUse` in `~/.claude/settings.json`,
or set `CC_GUARD_MODE` to `warn`.
