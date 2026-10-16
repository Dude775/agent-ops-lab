#!/usr/bin/env node
// genspark-index — a read-only MCP server that exposes a project tree as a
// structured, root-locked project index. Local tool surface for Claude Code.
//
// Tools: list_projects, get_project, search_projects, list_files, read_file,
//        index_status
// Resource: genspark://project/{id}
//
// Design: read-only, root-locked, traversal-guarded, deny-listed, size-capped,
// stateless (each call independent; the only cache is a derived, read-only scan).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './lib/config.js';
import { AppError, ERROR_CODES, ok, toErrorResult } from './lib/errors.js';
import { assertRootReadable, resolveInside } from './lib/safety.js';
import {
  assertProjectInsideRoot,
  findProject,
  getIndex,
  projectDetail,
  projectSummary,
  searchInProject,
  searchNamesAndPaths,
  walkFiles,
} from './lib/scanner.js';

const clamped = (n, min, max) => Math.min(max, Math.max(min, n));

function handle(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return toErrorResult(err);
    }
  };
}

// --- tool implementations ------------------------------------------------

function toolListProjects({ query, limit, offset } = {}) {
  const index = getIndex();
  const lim = clamped(Number.isFinite(limit) ? limit : config.defaultProjectLimit, 1, config.maxProjectLimit);
  const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  let rows = index.projects;
  if (query) {
    const needle = String(query).toLowerCase();
    rows = rows.filter(
      (p) => p.name.toLowerCase().includes(needle) || p.id.includes(needle) || p.kind.includes(needle),
    );
  }
  const page = rows.slice(off, off + lim).map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    kind: p.kind,
    status: p.status,
    file_count: p.file_count,
    last_indexed_at: p.last_indexed_at,
  }));
  return ok({ total: rows.length, offset: off, returned: page.length, projects: page });
}

function toolGetProject({ project_id }) {
  const index = getIndex();
  const project = findProject(index, project_id);
  assertProjectInsideRoot(project);
  return ok(projectDetail(project));
}

const MAX_BATCH_IDS = 500;

function summaryRow(project) {
  assertProjectInsideRoot(project);
  const s = projectSummary(project);
  return {
    project_id: project.id,
    name: project.name,
    path: project.path,
    summary: s.summary,
    summary_source: s.summary_source,
    truncated: s.truncated,
  };
}

function toolDescribeProject({ project_id, project_ids } = {}) {
  const hasSingle = typeof project_id !== 'undefined';
  const hasMany = typeof project_ids !== 'undefined';
  if (hasSingle === hasMany) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'provide exactly one of project_id or project_ids');
  }
  const index = getIndex();

  if (hasSingle) {
    const project = findProject(index, project_id); // legacy: unknown id -> UNKNOWN_PROJECT
    return ok({ requested: 1, returned: 1, unknown_ids: [], summaries: [summaryRow(project)] });
  }

  if (!Array.isArray(project_ids) || project_ids.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'project_ids must be a non-empty array');
  }
  if (project_ids.length > MAX_BATCH_IDS) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, `project_ids may contain at most ${MAX_BATCH_IDS} ids`);
  }

  const seen = new Set();
  const unknownIds = [];
  const summaries = [];
  for (const id of project_ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'every project_ids entry must be a non-empty string');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const project = index.projects.find((p) => p.id === id || p.name === id);
    if (!project) {
      unknownIds.push(id);
      continue;
    }
    summaries.push(summaryRow(project));
  }
  return ok({ requested: seen.size, returned: summaries.length, unknown_ids: unknownIds, summaries });
}

async function toolSearchProjects({ query, scope = 'all', limit } = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'query must be a non-empty string');
  }
  const lim = clamped(Number.isFinite(limit) ? limit : config.defaultSearchLimit, 1, config.maxSearchLimit);
  const index = getIndex();
  let matches = searchNamesAndPaths(index, query, scope, lim);
  if ((scope === 'content' || scope === 'all') && matches.length < lim) {
    for (const project of index.projects) {
      matches = matches.concat(searchInProject(project, query, lim - matches.length));
      if (matches.length >= lim) break;
    }
  }
  return ok({ query, scope, total: matches.length, matches: matches.slice(0, lim) });
}

function toolListFiles({ project_id, glob = '**/*', limit } = {}) {
  const index = getIndex();
  const project = findProject(index, project_id);
  assertProjectInsideRoot(project);
  const lim = clamped(Number.isFinite(limit) ? limit : config.defaultListLimit, 1, config.maxListLimit);
  const { files, truncated } = walkFiles(project.path, { limit: lim, glob: String(glob) });
  return ok({
    project_id: project.id,
    project_name: project.name,
    glob: String(glob),
    returned: files.length,
    truncated,
    files,
  });
}

function toolReadFile({ project_id, path: relPath, max_bytes } = {}) {
  const index = getIndex();
  const project = findProject(index, project_id);
  assertProjectInsideRoot(project);
  const abs = resolveInside(project.path, relPath, { mustExist: true });
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'path is a directory; use list_files', {
      path: relPath,
    });
  }
  const cap = clamped(Number.isFinite(max_bytes) ? max_bytes : config.maxReadBytes, 1, config.maxReadBytes);

  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(cap, st.size) + 1);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const truncated = st.size > cap || read > cap;
    const slice = buf.subarray(0, Math.min(cap, read));
    const binary = slice.includes(0);
    return ok({
      project_id: project.id,
      path: path.relative(project.path, abs).split(path.sep).join('/'),
      encoding: binary ? 'binary' : 'utf-8',
      size: st.size,
      truncated,
      content: binary ? '' : slice.toString('utf8'),
    });
  } finally {
    fs.closeSync(fd);
  }
}

function toolIndexStatus() {
  const index = getIndex();
  return ok({
    root: index.root,
    project_count: index.project_count,
    last_indexed_at: index.last_indexed_at,
    index_version: index.index_version,
  });
}

// --- server wiring -------------------------------------------------------

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function buildServer() {
  const server = new McpServer({ name: config.serverName, version: config.serverVersion });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the project folders directly under the index root. Optional case-insensitive name/kind filter with limit/offset paging.',
      inputSchema: {
        query: z.string().optional().describe('case-insensitive filter on name, id or kind'),
        limit: z.number().int().positive().optional().describe(`max rows (default ${config.defaultProjectLimit})`),
        offset: z.number().int().min(0).optional().describe('rows to skip (default 0)'),
      },
      outputSchema: {
        total: z.number().int(),
        offset: z.number().int(),
        returned: z.number().int(),
        projects: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            path: z.string(),
            kind: z.string(),
            status: z.string(),
            file_count: z.number().int(),
            last_indexed_at: z.string(),
          }),
        ),
      },
      annotations: readOnly,
    },
    handle(toolListProjects),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description:
        'Return one project: id, name, path, a short README preview, its config files and detected stack, and documentation status.',
      inputSchema: { project_id: z.string().describe('project id or exact folder name') },
      outputSchema: {
        id: z.string(),
        name: z.string(),
        path: z.string(),
        readme: z.string().nullable(),
        config_files: z.array(z.object({ path: z.string(), kind: z.string() })),
        detected_stack: z.array(z.string()),
        status: z.string(),
      },
      annotations: readOnly,
    },
    handle(toolGetProject),
  );

  server.registerTool(
    'describe_project',
    {
      title: 'Describe project',
      description:
        'One-line summary per project, taken from package.json description, else the first meaningful README line, else null. Give exactly one of project_id (single) or project_ids (batch).',
      inputSchema: {
        project_id: z.string().min(1).optional().describe('single project id or exact folder name'),
        project_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(500)
          .optional()
          .describe('batch of ids (max 500); duplicates removed, order preserved'),
      },
      outputSchema: {
        requested: z.number().int(),
        returned: z.number().int(),
        unknown_ids: z.array(z.string()),
        summaries: z.array(
          z.object({
            project_id: z.string(),
            name: z.string(),
            path: z.string(),
            summary: z.string().nullable(),
            summary_source: z.string(),
            truncated: z.boolean(),
          }),
        ),
      },
      annotations: readOnly,
    },
    handle(toolDescribeProject),
  );

  server.registerTool(
    'search_projects',
    {
      title: 'Search projects',
      description:
        'Search project names, paths, and (for scope=content|all) file contents. Content search skips deny-listed, binary and oversized files.',
      inputSchema: {
        query: z.string().describe('search text (case-insensitive)'),
        scope: z.enum(['names', 'paths', 'content', 'all']).optional().describe('default all'),
        limit: z.number().int().positive().optional().describe(`max matches (default ${config.defaultSearchLimit})`),
      },
      outputSchema: {
        query: z.string(),
        scope: z.string(),
        total: z.number().int(),
        matches: z.array(
          z.object({
            project_id: z.string(),
            path: z.string(),
            line_span: z.string().nullable(),
            snippet: z.string(),
            score: z.number(),
          }),
        ),
      },
      annotations: readOnly,
    },
    handle(toolSearchProjects),
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'List files inside one project matching a glob (default **/*). Paths are relative to the project folder. Deny-listed paths are omitted.',
      inputSchema: {
        project_id: z.string().describe('project id or exact folder name'),
        glob: z.string().optional().describe('glob relative to the project, default **/*'),
        limit: z.number().int().positive().optional().describe(`max rows (default ${config.defaultListLimit})`),
      },
      outputSchema: {
        project_id: z.string(),
        project_name: z.string(),
        glob: z.string(),
        returned: z.number().int(),
        truncated: z.boolean(),
        files: z.array(z.object({ path: z.string(), size: z.number().int(), mtime: z.string().nullable() })),
      },
      annotations: readOnly,
    },
    handle(toolListFiles),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        'Read one file inside a project (relative path). Path must stay under the project root, off the deny list; output is size-capped and reports truncation. Binary files return empty content with encoding=binary.',
      inputSchema: {
        project_id: z.string().describe('project id or exact folder name'),
        path: z.string().describe('file path relative to the project folder'),
        max_bytes: z.number().int().positive().optional().describe(`read cap (default ${config.maxReadBytes})`),
      },
      outputSchema: {
        project_id: z.string(),
        path: z.string(),
        encoding: z.string(),
        size: z.number().int(),
        truncated: z.boolean(),
        content: z.string(),
      },
      annotations: readOnly,
    },
    handle(toolReadFile),
  );

  server.registerTool(
    'index_status',
    {
      title: 'Index status',
      description: 'Report the locked root, number of indexed projects, when the index was built, and its version.',
      outputSchema: {
        root: z.string(),
        project_count: z.number().int(),
        last_indexed_at: z.string(),
        index_version: z.number().int(),
      },
      annotations: readOnly,
    },
    handle(toolIndexStatus),
  );

  server.registerResource(
    'project',
    new ResourceTemplate('genspark://project/{id}', { list: undefined }),
    {
      title: 'Indexed project',
      description: 'Read one indexed project as JSON (same shape as get_project).',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      try {
        const index = getIndex();
        const project = findProject(index, variables.id);
        assertProjectInsideRoot(project);
        const detail = projectDetail(project);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(detail),
            },
          ],
        };
      } catch (err) {
        const code = err instanceof AppError ? err.code : ERROR_CODES.INTERNAL;
        throw new Error(JSON.stringify({ error: code, message: err && err.message }));
      }
    },
  );

  return server;
}

async function main() {
  try {
    assertRootReadable();
  } catch (err) {
    // Soft-fail: keep the server up so clients get a structured ROOT_NOT_FOUND
    // from each tool instead of a dead process.
    process.stderr.write(`genspark-index: root check: ${err && err.message}\n`);
  }
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Build the index eagerly so index_status/list_projects answer deterministically.
  try {
    getIndex();
  } catch (err) {
    process.stderr.write(`genspark-index: index build failed: ${err && err.message}\n`);
  }
}

// Only start when executed directly (importable for tests).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`genspark-index: fatal: ${err && err.stack}\n`);
    process.exit(1);
  });
}

export { buildServer, toolListProjects, toolGetProject, toolDescribeProject, toolSearchProjects, toolListFiles, toolReadFile, toolIndexStatus };
