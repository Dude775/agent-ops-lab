# Test log — genspark-index v1.4.0 (sanitized build)

Date: 2026-10-16. Environment: Node v22.23.3, npm 10.9.9,
`@modelcontextprotocol/sdk@1.32.1`, `zod@4.6.7`.

This is the **public build**: a generic deny list plus `GENSPARK_INDEX_DENY_EXTRA`,
generic paths in docs and tests, and no real index output. Behaviour is identical
to the private v1.3.1 except for the deny-list defaults.

## 1. Real MCP handshake

```
serverInfo:   {"name":"genspark-index","version":"1.4.0"}
tools: list_projects, get_project, describe_project, search_projects,
       list_files, read_file, index_status
resourceTemplates: ["genspark://project/{id}"]
```

**7 tools + 1 resource template.**

## 2. Main suite — `node test/run.mjs`

```
PASS  tools/list returns the 7 documented tools
PASS  resource template genspark://project/{id} is registered
PASS  list_projects returns the 4 project dirs
PASS  deny-listed dir credentials is not indexed
PASS  loose files at root are not treated as projects
PASS  list_projects query filters
PASS  get_project returns a README preview
PASS  get_project lists config files
PASS  get_project detected_stack is an array
PASS  search_projects (content) finds a nested file
PASS  search_projects (names) matches project name
PASS  list_files glob returns markdown files
PASS  list_files reports truncation at the limit
PASS  read_file returns file content
PASS  read_file truncates at max_bytes
PASS  read_file marks binary files
PASS  describe_project single uses package.json description
PASS  describe_project falls back to README first meaningful line
PASS  describe_project falls back to listing when only repo files exist
PASS  describe_project truncates at 200 chars
PASS  describe_project batch dedupes, keeps order, collects unknown_ids
PASS  describe_project single unknown -> UNKNOWN_PROJECT
PASS  describe_project rejects both args
PASS  describe_project rejects neither arg
PASS  deny-listed file returns PERMISSION_DENIED
PASS  path traversal returns PATH_OUTSIDE_ROOT
PASS  deny-listed dir returns PERMISSION_DENIED
PASS  unknown project returns UNKNOWN_PROJECT
PASS  missing file returns NOT_FOUND
PASS  invalid argument (limit=0) is rejected, not crashed
PASS  empty query returns an actionable error
PASS  index_status reports the locked root and project count
PASS  resource read returns project JSON
PASS  unknown resource id errors
PASS  server process exits after client disconnect

35 passed, 0 failed
```

## 3. Hardening + scale + summary suite — `node test/hardening.mjs`

```
PASS  root-level symlink dir is not indexed as a project
PASS  nested symlink dir is not walked
PASS  content search does not read through a symlink
PASS  read through a symlink is refused (PATH_OUTSIDE_ROOT)
PASS  42 top-level dirs index as exactly 39 projects
PASS  the 3 deny dirs are excluded
PASS  one batch call describes all 39 projects
PASS  every summary is non-empty in the batch
PASS  summary skips emoji/section heading in README
PASS  summary falls back to a child README (child-readme)
PASS  child listing skips dot-directories
PASS  leaf folder falls back to a file listing
PASS  summary is none only when nothing applies

13 passed, 0 failed
```

Total: **48/48**. The symlink cases create links with
`fs.symlinkSync(target, path, 'junction')`, so on Windows they exercise a real
junction with no admin rights (no SKIP). The scale test uses a deny dir from the
generic list and one supplied via `GENSPARK_INDEX_DENY_EXTRA`.

## Verified vs not verified

**Verified** (stub roots above): handshake; all 7 tools; `describe_project` single
+ batch and every summary fallback; invalid input; all error codes; deny list
(generic + `DENY_EXTRA`); truncation; binary handling; symlink/junction escapes;
the 39/42 count; client disconnect.

**Not verified here**: a run against a real, large project tree on Windows — the
stub reproduces the layout, not the real folder counts, nesting depth or Windows
ACLs. `claude mcp add-json` was not run here.
