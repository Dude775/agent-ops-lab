# cc-guard.ps1 - v3.4
# PreToolUse guard for Claude Code on Windows.
# Reads the hook JSON from stdin, inspects tool_input.command, and denies on match.
#
# Contract (code.claude.com/docs/en/hooks):
#   stdin  : {"hook_event_name","tool_name","tool_input":{...,"command"},"cwd","session_id"}
#   deny   : write reason to stderr, exit 2
#   allow  : exit 0, no output
#
# Env:
#   CC_GUARD_MODE=warn          -> log matches but never block (calibration)
#   CC_GUARD_LOG=<path>         -> override log path (default ~/.claude/cc-guard.log)
#   CC_GUARD_ALLOW=<path>       -> override allow file (default ~/.claude/cc-guard-allow.txt)
#   CC_GUARD_DENY_EXTRA=a,b,c   -> extra site-specific names (secret folders, key files).
#                                  Any command that mentions one is denied (SEC-PATH-EXTRA).
#
# Fail-open on internal error, fail-closed on a rule match.
# Rationale: a crash must not brick every shell command; the deny list in
# settings.json remains as the second layer.
#
# ---------------------------------------------------------------------------
# CHANGE LOG
# v1 -> v2: three false positives found in calibration
#   ENCODED-PAYLOAD : "-Encoding utf8" matched "-enc"
#   SEC-PATH        : "process.env" matched ".env"
#   NET-PYTHON      : "python -m pip install requests" matched
# v2 -> v3: v2 introduced a REGRESSION - anchoring on start-of-command let
#           wrappers through, and two v1 catches were lost:
#     MISSED  timeout 30 curl https://x.tld
#     MISSED  env curl https://x.tld
#     MISSED  bash -c "curl https://x.tld"
#     MISSED  ls | xargs rm -rf
#     MISSED  find . -name x -exec rm -rf {} +
#     MISSED  sudo rm -rf /var/lib/x          (lookbehind demanded a leading space)
#     MISSED  node -e "require(\"https\").request(...)"  (only looked for "https.request")
#   FIX: stop enumerating "what may precede the command". Use a negative
#   lookbehind that only excludes the safe prefixes (docker/git/kubectl and
#   word chars / paths), so ANY wrapper before rm|curl is caught.
# v3 -> v3.1 (probe run):
#     MISSED  curl.exe / wget.exe / "C:\...\curl.exe" / /usr/bin/curl / /bin/rm -rf
#     MISSED  rm --recursive --force / "rm" -rf
#     FP      git -C <dir> rm -rf
#   FIX: allow path prefix and .exe, optional closing quote, long flags.
#   KNOWN LIMITS: variable indirection (c=curl; $c url) passes;
#                 any literal "curl " in text is denied (e.g. commit message).
#                 A script file that opens a socket (python exfil.py) passes.
# v3.1 -> v3.2:
#   NET-CLI needs a target-shaped token after the tool (flag/URL/var/domain/
#   localhost/user@host:/IP) -> "git commit -m 'fix curl timeout'" is ALLOWED.
#   FS-RM git exclusion only for `git [-C dir|-c k=v|--opt] rm` in one
#   invocation; ".git -exec rm", "X=git rm", "git x && rm" stay DENY.
#   New: cc-guard-allow.txt (user-owned, entries >= 8 chars) -> APPROVED in log.
#   Known gaps: c=curl; $c url | python exfil.py | docker rm -rf |
#               git commit -m "fix curl https://x" (word + URL in one string).
# v3.2 -> v3.3 (warn-log review before enforce):
#   FP  FS-RM-RECURSIVE : `rm -f m.txt` / `rm -f /tmp/app.lock` (most rm hits in the
#       log were single-file cleanup). Now only -r/--recursive, or -f + glob.
#   NEW FS-RM-BULK      : `xargs rm -f` / `find -exec rm -f` stay DENY.
#   Kept DENY on purpose: curl localhost, rm -rf of a scratch dir,
#       grep for secret|token|.env patterns, gh api ... | base64 -d.
# v3.3 -> v3.4 (public release):
#   SEC-PATH / SEC-ENUM hold generic patterns only (.env, id_rsa, *.pem, *.key,
#   credentials*, ...). Site-specific names moved out of the source into
#   CC_GUARD_DENY_EXTRA. The SEC-ENUM plugin-name exclusion was dropped.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$LogPath = if ($env:CC_GUARD_LOG) { $env:CC_GUARD_LOG } else { Join-Path $HOME '.claude\cc-guard.log' }
$Mode    = if ($env:CC_GUARD_MODE) { $env:CC_GUARD_MODE.ToLower() } else { 'enforce' }

# Approved one-off exceptions: one literal substring per line, written by the user.
# A matching command is LOGGED as APPROVED and allowed, even on a rule match.
# Empty the file when the job is done.
$AllowFile = if ($env:CC_GUARD_ALLOW) { $env:CC_GUARD_ALLOW } else { Join-Path $HOME '.claude\cc-guard-allow.txt' }
$AllowList = @()
if (Test-Path $AllowFile) {
  $AllowList = @(Get-Content $AllowFile -ErrorAction SilentlyContinue |
               Where-Object { $_ -and $_.Trim().Length -ge 8 } | ForEach-Object { $_.Trim() })
}

# Site-specific deny names live in the environment, not in this file.
$DenyExtra = @()
if ($env:CC_GUARD_DENY_EXTRA) {
  $DenyExtra = @($env:CC_GUARD_DENY_EXTRA -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Write-GuardLog([string]$line) {
  try {
    $dir = Split-Path $LogPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # rotate above 5MB -> .1 (overwrites the previous .1) so the log never grows unbounded
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 5MB)) {
      Move-Item -Path $LogPath -Destination ($LogPath + '.1') -Force
    }
    Add-Content -Path $LogPath -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $line) -Encoding UTF8
  } catch { }
}

$Rules = @(
  # ---------- destructive filesystem ----------
  # Any recursive `rm` (or `rm -f` on a glob) that is NOT a container/registry/git subcommand.
  # v3.3: plain `rm -f file` is allowed (daily temp-file cleanup); -r / --recursive / -f + `*` stay DENY.
  # v3.2: git exclusion only when `git [global opts] rm` is one invocation (".git" or "X=git" do not count)
  @{ n='FS-RM-RECURSIVE'; p='(?i)(?<![\w.\-])(?<!\b(?:docker|podman|nerdctl|kubectl)\s+)(?<!(?<![\w.\-/=])git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+)rm(?:\.exe)?["'']?\s+(?:-{1,2}[a-z-]+\s+)*(?:--recursive\b|-[a-z]*r[a-z]*\b|(?:--force|-[a-z]*f[a-z]*)\b[^\r\n;&|]*\*)' }
  # v3.3: rm -f via xargs / find -exec is input-driven mass delete -> DENY even without -r
  @{ n='FS-RM-BULK';      p='(?i)(?:\bxargs\b|-exec(?:dir)?\b)[^\r\n;&|]*?(?<![\w.\-])rm(?:\.exe)?["'']?\s+(?:-{1,2}[a-z-]+\s+)*(?:--force|--recursive|-[a-z]*[rf][a-z]*)\b' }
  @{ n='FS-PS-RECURSE';   p='(?i)\bRemove-Item\b[^\r\n]*-(Recurse|Force)' }
  @{ n='FS-CMD-DELETE';   p='(?i)\b(rd|rmdir|del)\s+/s' }
  @{ n='FS-DISK-OPS';     p='(?i)\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart|vssadmin|wbadmin)\b' }
  @{ n='FS-BULK-CLEAN';   p='(?i)\bClear-Content\b|\bRemove-Item\b[^\r\n]*(\*|\\\*|/\*)' }
  # ---------- git destructive ----------
  @{ n='GIT-FORCE-PUSH';  p='(?i)\bgit\s+push\b[^\r\n]*\s(-f|--force|--force-with-lease)\b' }
  @{ n='GIT-HARD-RESET';  p='(?i)\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|branch\s+-D)' }
  @{ n='GIT-HISTORY';     p='(?i)\bfilter-branch\b|\bfilter-repo\b' }
  # ---------- network egress ----------
  # v3: catches curl/wget under ANY wrapper (timeout, env, bash -c, xargs, sh -c).
  # v3.2: a target-shaped token must follow (flag, URL, variable, domain, localhost, quote)
  @{ n='NET-CLI';         p='(?i)(?<![\w.\-])(?<!\b(?:docker|podman|nerdctl|kubectl|git)\s+)(curl|wget|nc|ncat|telnet|ftp|sftp|scp|rsync|socat|chisel)(?:\.exe)?["'']?\s+(?:"|-{1,2}[\w-]|https?://|ftp://|\$\{?[A-Za-z_]|[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?=[\s:/"''`]|$)|localhost|\S+@\S+:|\d{1,3}(?:\.\d{1,3}){3})' }
  @{ n='NET-PS-WEB';      p='(?i)\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b' }
  @{ n='NET-DOTNET';      p='(?i)\b(System\.Net\.(WebClient|Http\.HttpClient)|WebClient|HttpClient)\b' }
  @{ n='NET-PYTHON';      p='(?i)\bpython[0-9.]*\b[^\r\n]*(\b(?:import|from)\s+(?:urllib|requests|httpx|socket|paramiko|aiohttp|subprocess|http\.client)\b|\b(?:urllib|requests|httpx|paramiko|aiohttp|http\.client|socket)\.)' }
  # v3: also catches require("https") / require("net") / require("node:https")
  @{ n='NET-NODE';        p='(?i)\bnode\b[^\r\n]*(\b(fetch\s*\(|https?\.request|https?\.get|axios|net\.connect|got\s*\()|require\s*\(\s*\\?[''"]\s*(?:node:)?(?:https?|net|tls|dgram)\s*\\?[''"])' }
  @{ n='NET-TUNNEL';      p='(?i)\b(ssh|plink|ngrok|cloudflared|ssh-keygen)\b' }
  @{ n='NET-PS-TCP';      p='(?i)\b(New-Object\s+System\.Net\.Sockets|Test-NetConnection|Test-Connection)\b' }
  # ---------- secret access (generic only; site-specific names come from CC_GUARD_DENY_EXTRA) ----------
  @{ n='SEC-PATH';        p='(?i)((?<![\w.])\.env(?:\.[a-z0-9]+)?\b|id_rsa|id_ed25519|\.ssh[\\/]|(?<![\w])credentials(?:[.\-_][\w.\-]*|[\\/])|\.aws[\\/]|\.npmrc|\.netrc|\.pem\b|\.key\b|\.pfx\b)' }
  @{ n='SEC-ENUM';        p='(?i)\b(Get-ChildItem|gci|ls|dir|find|fd|rg|grep|Select-String)\b[^\r\n]*\b(secret|token|passw|credential|vault)' }
  @{ n='SEC-PS-CRED';     p='(?i)\b(Get-Credential|ConvertTo-SecureString|Unprotect-CmsMessage|Get-StoredCredential|cmdkey)\b' }
  # ---------- persistence / evasion ----------
  @{ n='PERS-SCHEDULE';   p='(?i)\b(schtasks|Register-ScheduledTask|New-Service|sc\.exe\s+create|New-ItemProperty[^\r\n]*Run)\b' }
  @{ n='PERS-REG';        p='(?i)\breg\s+(add|import)\b' }
  @{ n='EVASION';         p='(?i)\b(Add-MpPreference|Set-MpPreference|Set-ExecutionPolicy|netsh\s+advfirewall|Enable-PSRemoting|winrm\s+set)\b' }
  @{ n='HIST-WIPE';       p='(?i)\b(Clear-History|history\s+-c|Clear-Content[^\r\n]*history)\b' }
  # ---------- privilege / mass process ----------
  @{ n='PRIV-ESC';        p='(?i)\b(runas|Start-Process[^\r\n]*-Verb\s+RunAs|AlwaysInstallElevated|SeDebugPrivilege)\b' }
  @{ n='MASS-KILL';       p='(?i)\b(taskkill|Stop-Process)\b[^\r\n]*(\/f\s+\/im|\s-\w*\s*\*|vmmem|vmwp|CoworkVMService)' }
  # ---------- encoded payloads ----------
  @{ n='ENCODED-PAYLOAD'; p='(?i)(?:^|\s)-(?:enc|encodedcommand)\b|FromBase64String|base64\s+-{1,2}(?:d|decode)\b' }
)

if ($DenyExtra.Count -gt 0) {
  $alt = ($DenyExtra | ForEach-Object { [regex]::Escape($_) }) -join '|'
  $Rules += @{ n='SEC-PATH-EXTRA'; p="(?i)(?:$alt)" }
}

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

  $ev = $raw | ConvertFrom-Json
  $tool = [string]$ev.tool_name
  if ($tool -ne 'Bash' -and $tool -ne 'PowerShell') { exit 0 }

  $cmd = [string]$ev.tool_input.command
  if ([string]::IsNullOrWhiteSpace($cmd)) { exit 0 }

  $hits = @()
  foreach ($r in $Rules) {
    if ($cmd -match $r.p) { $hits += $r.n }
  }
  if ($hits.Count -eq 0) { exit 0 }

  foreach ($a in $AllowList) {
    if ($cmd.Contains($a)) {
      Write-GuardLog ("APPROVED {0} tool={1} cmd={2}" -f ($hits -join ','), $tool, ($cmd -replace '\s+', ' '))
      exit 0
    }
  }

  $id = ($hits -join ',')
  Write-GuardLog ("{0} tool={1} cwd={2} cmd={3}" -f $id, $tool, $ev.cwd, ($cmd -replace '\s+', ' '))

  if ($Mode -eq 'warn') { exit 0 }

  $msg = @()
  $msg += "BLOCKED by cc-guard. Rule(s): $id"
  $msg += "Command: $cmd"
  $msg += "This command matches the egress/destruction guard installed at the user's request."
  $msg += "If it is genuinely needed, ask the user to approve it explicitly. Do not work around it."
  [Console]::Error.WriteLine(($msg -join "`n"))
  exit 2
}
catch {
  Write-GuardLog ("INTERNAL-ERROR {0}" -f $_.Exception.Message)
  exit 0
}
