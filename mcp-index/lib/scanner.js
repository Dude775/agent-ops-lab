import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';
import { isDenied, isInside, isRealInsideRoot } from './safety.js';

// Marker -> stack/kind labels, in priority order for the primary `kind`.
export const MARKERS = [
  { name: '.git', kind: 'repo', stack: 'git' },
  { name: 'Chart.yaml', kind: 'helm', stack: 'helm' },
  { name: 'terraform.tfstate', kind: 'terraform', stack: 'terraform' },
  { name: 'docker-compose.yml', kind: 'docker', stack: 'docker' },
  { name: 'package.json', kind: 'node', stack: 'node' },
  { name: 'requirements.txt', kind: 'python', stack: 'python' },
  { name: 'CLAUDE.md', kind: 'claude', stack: 'claude-md' },
  { name: 'AGENTS.md', kind: 'agents', stack: 'agents-md' },
  { name: 'README.md', kind: 'docs', stack: 'readme' },
];

const CONFIG_FILE_KINDS = new Map([
  ['README.md', 'docs'],
  ['CLAUDE.md', 'claude'],
  ['AGENTS.md', 'agents'],
  ['.cursorrules', 'cursor'],
  ['.mcp.json', 'mcp'],
  ['package.json', 'node'],
  ['requirements.txt', 'python'],
  ['Chart.yaml', 'helm'],
  ['docker-compose.yml', 'docker'],
  ['terraform.tfstate', 'terraform'],
]);

export function toId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countFiles(dir) {
  let count = 0;
  let bytes = 0;
  const stack = [dir];
  let guard = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (isDenied(full)) continue;
      if (++guard > config.maxScanEntries) return { count, bytes, truncated: true };
      if (e.isDirectory()) {
        if (e.isSymbolicLink() || !isRealInsideRoot(full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        count += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { count, bytes, truncated: false };
}

function markersFor(dir) {
  const found = [];
  const stack = [];
  for (const m of MARKERS) {
    try {
      if (fs.existsSync(path.join(dir, m.name))) {
        found.push(m);
        stack.push(m.stack);
      }
    } catch {
      /* ignore */
    }
  }
  return { found, stack };
}

function classify(found) {
  const primary = found[0];
  const documented = found.some((m) => ['CLAUDE.md', 'AGENTS.md', 'README.md'].includes(m.name));
  return {
    kind: primary ? primary.kind : 'unknown',
    stack: [...new Set(found.map((m) => m.stack))],
    status: documented ? 'documented' : 'undocumented',
  };
}

/**
 * Build a read-only, in-memory index of the immediate project folders under the
 * locked root. Nothing is written to disk. Nesting inside a project is handled
 * by list_files/search_projects, not by flattening the overlay into fake
 * top-level projects.
 */
export function buildIndex({ now = new Date() } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(config.root, { withFileTypes: true });
  } catch (err) {
    throw new AppError(ERROR_CODES.ROOT_NOT_FOUND, 'cannot read index root', {
      root: config.root,
      cause: String(err && err.message),
    });
  }

  const projects = [];
  const usedIds = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const full = path.join(config.root, entry.name);
    if (isDenied(full)) continue;
    // Skip reparse points (symlinks/junctions) that resolve outside the root.
    if (!isRealInsideRoot(full)) continue;

    let id = toId(entry.name);
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const { found, stack } = markersFor(full);
    const cls = classify(found);
    const counts = countFiles(full);
    projects.push({
      id,
      name: entry.name,
      path: full,
      kind: cls.kind,
      status: cls.status,
      file_count: counts.count,
      last_indexed_at: now.toISOString(),
      _stack: cls.stack,
      _markers: found.map((m) => m.name),
      _bytes: counts.bytes,
      _countTruncated: counts.truncated,
    });
  }

  return {
    root: config.root,
    project_count: projects.length,
    last_indexed_at: now.toISOString(),
    index_version: config.indexVersion,
    projects,
  };
}

let _cached = null;

/** Lazy, process-lifetime cache of the index (derived read-only data, not client state). */
export function getIndex({ refresh = false, now } = {}) {
  if (!_cached || refresh) _cached = buildIndex(now ? { now } : {});
  return _cached;
}

export function findProject(index, projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'project_id must be a non-empty string');
  }
  const byId = index.projects.find((p) => p.id === projectId);
  if (byId) return byId;
  const byName = index.projects.find((p) => p.name === projectId);
  if (byName) return byName;
  throw new AppError(ERROR_CODES.UNKNOWN_PROJECT, `no project with id "${projectId}"`, {
    known_ids: index.projects.map((p) => p.id),
  });
}

function firstReadmeLine(file, maxChars) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

export function projectDetail(project) {
  const readme = path.join(project.path, 'README.md');
  const configFiles = [];
  for (const [name, kind] of CONFIG_FILE_KINDS) {
    const full = path.join(project.path, name);
    try {
      if (fs.existsSync(full) && !isDenied(full)) configFiles.push({ path: name, kind });
    } catch {
      /* ignore */
    }
  }
  let readmeText = null;
  try {
    if (fs.existsSync(readme) && !isDenied(readme)) {
      readmeText = firstReadmeLine(readme, config.readmePreviewChars);
    }
  } catch {
    /* ignore */
  }
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    readme: readmeText,
    config_files: configFiles,
    detected_stack: project._stack,
    status: project.status,
  };
}

// --- one-line summary (describe_project) ---------------------------------

export const SUMMARY_MAX_CHARS = 200;

function clipSummary(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= SUMMARY_MAX_CHARS) return { summary: clean, truncated: false };
  return { summary: `${clean.slice(0, SUMMARY_MAX_CHARS - 1)}…`, truncated: true };
}

function normalizeForCompare(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Common README section headings that are not a project description.
const SECTION_HEADINGS = new Set([
  'about', 'installation', 'install', 'usage', 'gettingstarted', 'getstarted', 'features',
  'requirements', 'overview', 'tableofcontents', 'toc', 'contents', 'license', 'licence',
  'contributing', 'examples', 'example', 'demo', 'screenshots', 'description', 'summary',
  'intro', 'introduction', 'projectstructure', 'structure', 'setup', 'quickstart', 'changelog',
  'roadmap', 'credits', 'acknowledgements', 'acknowledgments', 'faq', 'support', 'contact',
  'notes', 'todo', 'documentation', 'docs', 'prerequisites', 'stack', 'techstack', 'builtwith',
  'technologies', 'links', 'resources', 'references', 'background', 'motivation', 'goals',
]);

// Well-known non-project child directories, skipped when summarising containers.
const NOISE_DIRS = new Set([
  'node_modules', '.git', '.github', '.gitlab', 'dist', 'build', 'out', 'target', 'venv',
  '.venv', '__pycache__', '.next', '.nuxt', 'coverage', '.idea', '.vscode', '.cache',
  'vendor', '.pytest_cache', '.mypy_cache',
]);

// OS/editor cruft skipped when a leaf folder is summarised by its files.
const NOISE_FILES = new Set(['desktop.ini', 'thumbs.db']);

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('<!--')) return true;
  if (/^[-=*_]{3,}$/.test(t)) return true; // horizontal rule
  if (t.startsWith('<')) return true; // raw HTML
  // badge / image / link-only lines, e.g. [![build](...)](...) or ![logo](...)
  if (/^[!\[]?\[?[^\]]*\]\([^)]*\)/.test(t)) return true;
  if (/^\+\d+$/.test(t) || t.startsWith('http')) return true;
  if (/^#+\s*$/.test(t)) return true;
  return false;
}

function firstMeaningfulLine(file, projectName) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const nameNorm = normalizeForCompare(projectName);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    if (isNoiseLine(raw)) continue;
    const stripped = raw
      .replace(/^#{1,6}\s*/, '')
      .replace(/^>\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (!stripped) continue;
    // Needs at least one letter in any script (drops emoji/punctuation-only lines).
    if (!/\p{L}/u.test(stripped)) continue;
    const norm = normalizeForCompare(stripped);
    // Skip a title line that is just the project name.
    if (nameNorm && norm === nameNorm) continue;
    // Skip common section headings, including emoji headings like "👨‍💻 About".
    if (norm && SECTION_HEADINGS.has(norm)) continue;
    return stripped;
  }
  return null;
}

/** Immediate child directories that are real, inside-root, and not denied/noise. */
function listChildDirs(project) {
  let entries;
  try {
    entries = fs.readdirSync(project.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const children = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue; // tooling dirs like .claude / .terraform
    if (NOISE_DIRS.has(e.name.toLowerCase())) continue;
    const full = path.join(project.path, e.name);
    if (isDenied(full)) continue;
    if (e.isSymbolicLink() || !isRealInsideRoot(full)) continue;
    children.push({ name: e.name, full });
  }
  children.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

/** Top-level files of a leaf folder (no readable children), for the listing fallback. */
function listTopFiles(project) {
  let entries;
  try {
    entries = fs.readdirSync(project.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    if (NOISE_FILES.has(e.name.toLowerCase())) continue;
    if (isDenied(path.join(project.path, e.name))) continue;
    files.push(e.name);
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

/** First usable description from one child directory: package.json → README → CLAUDE.md/AGENTS.md. */
function childText(child) {
  const pkgPath = path.join(child.full, 'package.json');
  if (!isDenied(pkgPath)) {
    const pkg = readJsonSafe(pkgPath);
    if (pkg && typeof pkg.description === 'string' && pkg.description.trim()) {
      return pkg.description;
    }
  }
  for (const name of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(child.full, name);
    if (isDenied(file)) continue;
    const line = firstMeaningfulLine(file, child.name);
    if (line) return line;
  }
  return null;
}

/**
 * One-line summary for a project, in priority order:
 *   1. its own package.json `description`      -> "package.json"
 *   2. its own README first meaningful line    -> "readme"
 *   3. a child folder's description one level  -> "child-readme" (prefixed with the child name)
 *   4. "contains: a, b, c (+N)" from children   -> "listing"
 *   5. null                                     -> "none"
 * Deny-listed sources and reparse points are skipped throughout.
 */
export function projectSummary(project) {
  const pkgPath = path.join(project.path, 'package.json');
  if (!isDenied(pkgPath)) {
    const pkg = readJsonSafe(pkgPath);
    if (pkg && typeof pkg.description === 'string' && pkg.description.trim()) {
      return { ...clipSummary(pkg.description), summary_source: 'package.json' };
    }
  }

  const readmePath = path.join(project.path, 'README.md');
  if (!isDenied(readmePath)) {
    const line = firstMeaningfulLine(readmePath, project.name);
    if (line) return { ...clipSummary(line), summary_source: 'readme' };
  }

  const children = listChildDirs(project);
  for (const child of children) {
    const text = childText(child);
    if (text) {
      return { ...clipSummary(`${child.name}: ${text}`), summary_source: 'child-readme' };
    }
  }

  // Listing: child directories, or — for a leaf folder — its top-level files.
  const items = children.length ? children.map((c) => c.name) : listTopFiles(project);
  if (items.length) {
    const shown = items.slice(0, 5).join(', ');
    const more = items.length > 5 ? ` (+${items.length - 5})` : '';
    return { ...clipSummary(`contains: ${shown}${more}`), summary_source: 'listing' };
  }

  return { summary: null, summary_source: 'none', truncated: false };
}

// --- glob + walk ---------------------------------------------------------

export function globToRegExp(glob) {
  let g = String(glob || '**/*').replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Walk a project tree, honouring the deny list and an entry cap. */
export function walkFiles(rootDir, { limit = config.maxListLimit, glob = '**/*' } = {}) {
  const re = globToRegExp(glob);
  const out = [];
  const stack = [rootDir];
  let guard = 0;
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (isDenied(full)) continue;
      if (++guard > config.maxScanEntries) return { files: out, truncated: true };
      if (e.isDirectory()) {
        if (e.isSymbolicLink() || !isRealInsideRoot(full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const rel = path.relative(rootDir, full).split(path.sep).join('/');
        if (!re.test(rel)) continue;
        let size = 0;
        let mtime = null;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          /* ignore */
        }
        out.push({ path: rel, size, mtime });
        if (out.length >= limit) break;
      }
    }
  }
  return { files: out, truncated: out.length >= limit };
}

// --- content search ------------------------------------------------------

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function* iterateTextFiles(rootDir) {
  const stack = [rootDir];
  let guard = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (isDenied(full)) continue;
      if (++guard > config.maxScanEntries) return;
      if (e.isDirectory()) {
        if (e.isSymbolicLink() || !isRealInsideRoot(full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.size > config.maxContentFileBytes) continue;
        yield full;
      }
    }
  }
}

export function searchInProject(project, query, limit) {
  const needle = query.toLowerCase();
  const matches = [];
  for (const file of iterateTextFiles(project.path)) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) continue;
    const rel = path.relative(project.path, file).split(path.sep).join('/');
    const before = text.slice(0, idx);
    const lineStart = before.split('\n').length;
    let hits = 0;
    while (idx !== -1 && hits < 3) {
      const from = Math.max(0, idx - config.snippetRadius);
      const to = Math.min(text.length, idx + needle.length + config.snippetRadius);
      matches.push({
        project_id: project.id,
        path: `${project.name}/${rel}`,
        line_span: String(lineStart + hits),
        snippet: text.slice(from, to).replace(/\s+/g, ' ').trim(),
        score: hits === 0 ? 1 : 0.5,
      });
      hits += 1;
      idx = lower.indexOf(needle, idx + needle.length);
      if (matches.length >= limit) return matches;
    }
    if (matches.length >= limit) return matches;
  }
  return matches;
}

export function searchNamesAndPaths(index, query, scope, limit) {
  const needle = query.toLowerCase();
  const matches = [];
  for (const p of index.projects) {
    let rel;
    try {
      rel = path.relative(config.root, p.path).split(path.sep).join('/');
    } catch {
      rel = p.name;
    }
    if ((scope === 'all' || scope === 'names') && p.name.toLowerCase().includes(needle)) {
      matches.push({
        project_id: p.id,
        path: p.name,
        line_span: null,
        snippet: `project name: ${p.name}`,
        score: 2,
      });
    }
    if ((scope === 'all' || scope === 'paths') && rel.toLowerCase().includes(needle)) {
      matches.push({
        project_id: p.id,
        path: rel,
        line_span: null,
        snippet: `project path: ${p.path}`,
        score: 1.5,
      });
    }
    if (matches.length >= limit) break;
  }
  return matches.slice(0, limit);
}

/** Guard used by tests/tools: make sure a project path is still under root. */
export function assertProjectInsideRoot(project) {
  if (!isInside(config.root, project.path)) {
    throw new AppError(ERROR_CODES.PATH_OUTSIDE_ROOT, 'project path escapes the index root', {
      path: project.path,
    });
  }
}

export function _resetIndexCache() {
  _cached = null;
}
