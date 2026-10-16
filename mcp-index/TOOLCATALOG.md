# Tool catalog — genspark-index

All tools are read-only and require no arguments beyond those listed. Every
successful result is returned as JSON in `content[0].text` **and** as
`structuredContent`. Every failure is returned with `isError: true` and a JSON
body `{ "error": "<CODE>", "message": "...", "details": { ... } }` — never a crash.

Error codes: `UNKNOWN_PROJECT`, `PATH_OUTSIDE_ROOT`, `NOT_FOUND`, `TOO_LARGE`,
`PERMISSION_DENIED`, `INVALID_ARGUMENT`, `ROOT_NOT_FOUND`, `INTERNAL`.

---

## 1. `list_projects`

List the project folders directly under the root, with paging and an optional
filter.

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | no | — | case-insensitive filter on name / id / kind |
| `limit` | integer ≥ 1 | no | 50 | max 500 |
| `offset` | integer ≥ 0 | no | 0 | rows to skip |

Returns:

```json
{
  "total": 51,
  "offset": 0,
  "returned": 50,
  "projects": [
    { "id": "example-project", "name": "example-project",
      "path": "C:\\projects\\example-project", "kind": "docs",
      "status": "documented", "file_count": 42,
      "last_indexed_at": "2026-10-14T02:40:00.000Z" }
  ]
}
```

Errors: `ROOT_NOT_FOUND` (root missing/unreadable).

`kind` is the primary marker kind in priority order — `repo` (`.git`), `helm`
(`Chart.yaml`), `terraform`, `docker`, `node` (`package.json`), `python`
(`requirements.txt`), `claude` (`CLAUDE.md`), `agents` (`AGENTS.md`), `docs`
(`README.md`), else `unknown`.
`status` is `documented` when the folder has a `README.md`/`CLAUDE.md`/`AGENTS.md`,
else `undocumented`.

---

## 2. `get_project`

| Param | Type | Required |
|---|---|---|
| `project_id` | string | yes — project id or exact folder name |

Returns:

```json
{
  "id": "example-project",
  "name": "example-project",
  "path": "C:\\projects\\example-project",
  "readme": "# DevOps Field Guide\nFirst lines of the README…",
  "config_files": [ { "path": "README.md", "kind": "docs" },
                    { "path": "CLAUDE.md", "kind": "claude" } ],
  "detected_stack": ["git", "readme"],
  "status": "documented"
}
```

`readme` is a short preview (first ~1500 chars) or `null`. Full content is
available on demand through `read_file`.

Errors: `UNKNOWN_PROJECT`, `INVALID_ARGUMENT`.

---

## 3. `search_projects`

| Param | Type | Required | Default |
|---|---|---|---|
| `query` | string | yes (non-empty) | — |
| `scope` | `names` \| `paths` \| `content` \| `all` | no | `all` |
| `limit` | integer ≥ 1 | no | 20 (max 200) |

Returns:

```json
{
  "query": "kubernetes", "scope": "content", "total": 3,
  "matches": [
    { "project_id": "example-project", "path": "example-project/docs/notes.md",
      "line_span": "12", "snippet": "…deploys kubernetes workloads…", "score": 1 }
  ]
}
```

Content search walks each project, skipping deny-listed paths, binary files and
files larger than `GENSPARK_INDEX_MAX_CONTENT_FILE_BYTES`. `line_span` is `null`
for name/path matches.

Errors: `INVALID_ARGUMENT` (empty query), `ROOT_NOT_FOUND`.

---

## 4. `list_files`

| Param | Type | Required | Default |
|---|---|---|---|
| `project_id` | string | yes | — |
| `glob` | string | no | `**/*` |
| `limit` | integer ≥ 1 | no | 200 (max 2000) |

Returns `{ project_id, project_name, glob, returned, truncated, files:[{path,size,mtime}] }`.
`path` is relative to the project folder (forward slashes). Deny-listed paths are
omitted entirely.

Errors: `UNKNOWN_PROJECT`, `INVALID_ARGUMENT`.

---

## 5. `read_file`

| Param | Type | Required | Default |
|---|---|---|---|
| `project_id` | string | yes | — |
| `path` | string | yes | path relative to the project folder |
| `max_bytes` | integer ≥ 1 | no | 65536 (max 4 MB) |

Returns `{ project_id, path, encoding: "utf-8" | "binary", size, truncated, content }`.
Binary files (NUL byte in the first bytes) return `encoding:"binary"` and empty
`content`. `truncated` is true when the file is larger than the cap.

Errors: `UNKNOWN_PROJECT`, `PATH_OUTSIDE_ROOT`, `PERMISSION_DENIED`, `NOT_FOUND`,
`INVALID_ARGUMENT` (directory path, or malformed path).

---

## 6. `index_status`

No parameters. Returns `{ root, project_count, last_indexed_at, index_version }`.
Use it to confirm which root the server is locked to.

Errors: `ROOT_NOT_FOUND`.

---

## 7. `describe_project`

One-line summary per project — for filling a catalog without opening files.

| Param | Type | Required | Notes |
|---|---|---|---|
| `project_id` | string | one of the two | single project (legacy path) |
| `project_ids` | string[] | one of the two | batch, 1–500 entries |

Provide **exactly one** of `project_id` / `project_ids`; both or neither →
`INVALID_ARGUMENT`. In batch mode duplicates are removed and order preserved.

Returns one envelope for both paths:

```json
{
  "requested": 2,
  "returned": 2,
  "unknown_ids": [],
  "summaries": [
    { "project_id": "example-project", "name": "example-project",
      "path": "C:\\projects\\example-project",
      "summary": "Field guide for DevOps workflows…",
      "summary_source": "package.json", "truncated": false }
  ]
}
```

`summary` derivation, in priority order:

1. non-empty `description` in `package.json` → `summary_source: "package.json"`;
2. else the first meaningful line of `README.md` → `"readme"` — leading `#`/`>`
   are stripped, and a line that is only the project's own name, a badge/HTML/rule
   line, or a common section heading (e.g. `About`, `Installation`, `👨‍💻 About`)
   is skipped;
3. else a child folder one level down contributes its `package.json`
   `description` → README → `CLAUDE.md`/`AGENTS.md` first meaningful line →
   `"child-readme"`, prefixed with the child's name (`"sub-one: Does sub things."`);
4. else `"listing"` — `contains: a, b, c (+N)` from the immediate child
   directories, or — for a leaf folder with no children — from its top-level files;
5. else `null`, `"none"`.

`summary` is capped at 200 characters (`truncated: true` when cut). Deny-listed
paths, reparse points, dot-entries (`.claude`, `.terraform`, `.git`, …) and
well-known noise dirs/files (`node_modules`, `dist`, `venv`, `desktop.ini`, …)
are skipped in every step.

Errors: single `project_id` not found → `UNKNOWN_PROJECT` (unchanged);
batch ids not found are collected in `unknown_ids` without failing the call;
`INVALID_ARGUMENT` for both/neither param or bad input.

---

## Resource — `genspark://project/{id}`

Read one project as `application/json` (same shape as `get_project`).
Unknown ids raise a JSON error body.

---

## Deny list

Enforced on every path (reads, listings and content search), case-insensitively,
against path segments and file extensions:

`.env`, `.env.local`, `.env.production`, `.env.development`, `.ssh`, `.aws`,
`.gnupg`, `.netrc`, `.npmrc`, `id_rsa`, `id_ed25519`, `credentials`,
`credentials.json`, `secrets.json`, `secrets.yaml`, `secrets.yml`,
`service-account.json`, `kubeconfig`, and extensions `.pem`, `.key`, `.pfx`,
`.p12`, `.keystore`, `.jks`, `.ppk`. Add your own names with
`GENSPARK_INDEX_DENY_EXTRA` — site-specific names belong there, not in the source.
