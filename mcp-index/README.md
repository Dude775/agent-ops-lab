# genspark-index — read-only MCP server for a project tree

A local MCP server that exposes the project folders under a locked root as a
structured, read-only index that Claude Code can discover, search and read. The
root is whatever you point `GENSPARK_INDEX_ROOT` at (default `~/projects`).

Design guarantees:

- **Read-only** — the server never writes, moves or deletes anything. There is
  no write tool at all.
- **Root-locked** — every path is resolved against `GENSPARK_INDEX_ROOT`; anything
  that escapes the root is refused (`PATH_OUTSIDE_ROOT`).
- **Traversal-guarded + symlink/junction-checked** — `..`, absolute paths and
  symlinks/junctions that resolve outside the root are refused on read, and
  reparse points are skipped when indexing, listing and content-searching, so
  they cannot leak names or content either.
- **Deny-listed** — a conservative credential set (`.env`, `id_rsa`, `.ssh`,
  `credentials.json`, `*.pem`, `*.key`, …) is refused even when the path is
  otherwise valid (`PERMISSION_DENIED`). Add your own names per install with
  `GENSPARK_INDEX_DENY_EXTRA`. Deny is enforced explicitly, not only through
  traversal checks.
- **Size-capped** — reads are capped (`max_bytes`, default 64 KB) and truncation is
  reported; binary files are detected and returned empty rather than garbled.
- **Stateless** — each call is independent. The only state is a derived, read-only
  scan of the root built once at startup.

Tools: `list_projects`, `get_project`, `describe_project`, `search_projects`,
`list_files`, `read_file`, `index_status`. Resource: `genspark://project/{id}`.
See `TOOLCATALOG.md`.

## Requirements

- Node.js **20 or newer** (built and tested on Node 22).
- Pinned dependencies: `@modelcontextprotocol/sdk@1.32.1`, `zod@4.6.7`.

## Install

```bat
cd <folder you extracted this to>
npm install
```

`npm install` pulls the two pinned packages. No build step; the server is plain
ESM JavaScript.

## Register with Claude Code

Use an absolute path to `server.js` (example `C:\tools\mcp-index\server.js`) and
point `GENSPARK_INDEX_ROOT` at the tree you want indexed.

Claude Code 2.1.1+ (user scope):

```bat
claude mcp add-json genspark-index "{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"C:\\\\tools\\\\mcp-index\\\\server.js\"],\"env\":{\"GENSPARK_INDEX_ROOT\":\"C:\\\\projects\"}}" --scope user
```

Older Claude Code, or if you prefer a project config, add to a `.mcp.json`:

```json
{
  "mcpServers": {
    "genspark-index": {
      "command": "node",
      "args": ["C:\\tools\\mcp-index\\server.js"],
      "env": { "GENSPARK_INDEX_ROOT": "C:\\projects" }
    }
  }
}
```

Then restart Claude Code and check with `claude mcp list` — the server should
report the 7 tools above.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GENSPARK_INDEX_ROOT` | `~/projects` | Root the server is locked to. |
| `GENSPARK_INDEX_MAX_BYTES` | `65536` | Default read cap per `read_file` call (1 KB – 4 MB). |
| `GENSPARK_INDEX_MAX_CONTENT_FILE_BYTES` | `524288` | Largest file considered by content search. |
| `GENSPARK_INDEX_MAX_SCAN_ENTRIES` | `200000` | Safety cap on directory-walk entries. |
| `GENSPARK_INDEX_DENY_EXTRA` | *(empty)* | Comma-separated extra deny names/substrings, e.g. your own vault folder names. |

## Run / test

```bat
npm start         :: start on stdio
npm test          :: end-to-end MCP client test against a temporary stub root
```

`npm test` spawns the real server, performs the MCP handshake, discovers the
tools and calls every one — including invalid input, deny-list hits, traversal
attempts and a client disconnect. It does not touch your real project tree.

## A note on what not to commit

This repo ships with a **generic** deny list on purpose. Site-specific names
(secret folders, key directories) belong in `GENSPARK_INDEX_DENY_EXTRA` at
install time, not in the source. Likewise, keep real index output (project names
and paths from your own machine) out of the repo.
