#!/usr/bin/env node
// Hardening + scale tests, separate from the main suite because they need
// their own root and environment:
//   A. symlink/junction escape attempts must not be indexed, walked, searched
//      or read (defence beyond the lexical path check).
//   B. a root shaped like the real one — 42 top-level dirs, 3 of them deny
//      listed — indexes exactly 39, and a single describe_project batch call
//      returns all 39.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.js');

let pass = 0;
let fail = 0;
const log = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    log.push(`PASS  ${name}`);
  } else {
    fail += 1;
    log.push(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function withServer(root, extraEnv, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, GENSPARK_INDEX_ROOT: root, ...extraEnv },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'hardening-test', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args || {} });
    return { isError: Boolean(r.isError), data: JSON.parse(r.content[0].text) };
  };
  try {
    await fn(call);
  } finally {
    await client.close();
  }
}

// ---- A. symlink escape --------------------------------------------------

const symRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-sym-root-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-sym-outside-'));
fs.writeFileSync(path.join(outside, 'leak.txt'), 'OUTSIDE-SECRET-MARKER\n');
fs.mkdirSync(path.join(symRoot, 'proj-ok'), { recursive: true });
fs.writeFileSync(path.join(symRoot, 'proj-ok', 'README.md'), '# ok\ninside only\n');
fs.mkdirSync(path.join(symRoot, 'proj-ok', 'sub'), { recursive: true });
fs.writeFileSync(path.join(symRoot, 'proj-ok', 'sub', 'note.md'), 'note\n');

let symlinksMade = true;
try {
  // 'junction' requires no admin on Windows; on POSIX the type is ignored and a
  // normal directory symlink is created. So the same call exercises a real
  // Windows junction there and a symlink here — no platform skip.
  fs.symlinkSync(outside, path.join(symRoot, 'proj-link'), 'junction');
  fs.symlinkSync(outside, path.join(symRoot, 'proj-ok', 'link-out'), 'junction');
} catch {
  symlinksMade = false;
}

if (!symlinksMade) {
  log.push('SKIP  symlink/junction escape tests (link creation unavailable on this platform)');
} else {
  await withServer(symRoot, {}, async (call) => {
    const projects = await call('list_projects', {});
    const ids = projects.data.projects.map((p) => p.id);
    check('root-level symlink dir is not indexed as a project', !ids.includes('proj-link'), ids.join(','));

    const files = await call('list_files', { project_id: 'proj-ok' });
    const paths = files.data.files.map((f) => f.path);
    check('nested symlink dir is not walked', !paths.some((p) => p.startsWith('link-out')), paths.join(','));

    const search = await call('search_projects', { query: 'OUTSIDE-SECRET-MARKER', scope: 'content' });
    check('content search does not read through a symlink', search.data.total === 0, JSON.stringify(search.data));

    const read = await call('read_file', { project_id: 'proj-ok', path: 'link-out/leak.txt' });
    check(
      'read through a symlink is refused (PATH_OUTSIDE_ROOT)',
      read.isError && read.data.error === 'PATH_OUTSIDE_ROOT',
      JSON.stringify(read.data),
    );
  });
}
fs.rmSync(symRoot, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

// ---- B. real-shape scale ------------------------------------------------

const scaleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-scale-root-'));
const denyDirs = ['.ssh', 'credentials', 'private-vault'];
const expectedIds = [];
for (let i = 1; i <= 39; i += 1) {
  const name = `proj-${String(i).padStart(2, '0')}`;
  expectedIds.push(name);
  fs.mkdirSync(path.join(scaleRoot, name), { recursive: true });
  fs.writeFileSync(
    path.join(scaleRoot, name, 'package.json'),
    JSON.stringify({ name, description: `Description for ${name}` }),
  );
}
for (const d of denyDirs) {
  fs.mkdirSync(path.join(scaleRoot, d), { recursive: true });
  fs.writeFileSync(path.join(scaleRoot, d, 'x.txt'), 'should never be indexed\n');
}

await withServer(scaleRoot, { GENSPARK_INDEX_DENY_EXTRA: 'private-vault' }, async (call) => {
  const listed = await call('list_projects', {});
  check('42 top-level dirs index as exactly 39 projects', listed.data.total === 39, String(listed.data.total));
  const ids = listed.data.projects.map((p) => p.id);
  check(
    'the 3 deny dirs are excluded',
    denyDirs.every((d) => !ids.map((i) => i.toLowerCase()).includes(d.toLowerCase())),
    ids.join(','),
  );

  const batch = await call('describe_project', { project_ids: ids });
  check(
    'one batch call describes all 39 projects',
    batch.data.requested === 39 && batch.data.returned === 39 && batch.data.unknown_ids.length === 0,
    JSON.stringify({ r: batch.data.requested, ret: batch.data.returned, u: batch.data.unknown_ids.length }),
  );
  check(
    'every summary is non-empty in the batch',
    batch.data.summaries.every((s) => typeof s.summary === 'string' && s.summary.length > 0),
  );
});
fs.rmSync(scaleRoot, { recursive: true, force: true });

// ---- C. summary fallbacks (v1.3.0) --------------------------------------

const sumRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-summary-root-'));
const mk = (rel, content) => {
  const full = path.join(sumRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
// heading/emoji skip
mk('proj-heading/README.md', '# proj-heading\n👨‍💻 About\nReal one-line description here.\n');
// child-readme: first child (sorted) contributes its README
mk('container-a/sub-one/README.md', '# sub-one\nDoes sub things.\n');
mk('container-a/sub-two/package.json', JSON.stringify({ name: 'sub-two', description: 'sub two' }));
// listing: children exist but carry no description of their own (dot-dir skipped)
mkdirp('container-b/c1');
mkdirp('container-b/c2');
mkdirp('container-b/.hidden-tooling');
mk('container-b/c1/data.txt', 'x\n');
mk('container-b/c2/data.txt', 'y\n');
// leaf folder: no children and no README, summarised by its files
mk('leaf-files/a.py', 'print(1)\n');
mk('leaf-files/b.py', 'print(2)\n');
mk('leaf-files/.secret-ish', 'dotfile\n');
// truly empty: nothing to describe
mkdirp('truly-empty');

function mkdirp(rel) {
  fs.mkdirSync(path.join(sumRoot, rel), { recursive: true });
}

await withServer(sumRoot, {}, async (call) => {
  const heading = await call('describe_project', { project_id: 'proj-heading' });
  check(
    'summary skips emoji/section heading in README',
    heading.data.summaries[0].summary === 'Real one-line description here.' && heading.data.summaries[0].summary_source === 'readme',
    JSON.stringify(heading.data.summaries[0]),
  );

  const child = await call('describe_project', { project_id: 'container-a' });
  check(
    'summary falls back to a child README (child-readme)',
    child.data.summaries[0].summary_source === 'child-readme' && child.data.summaries[0].summary === 'sub-one: Does sub things.',
    JSON.stringify(child.data.summaries[0]),
  );

  const listing = await call('describe_project', { project_id: 'container-b' });
  check(
    'child listing skips dot-directories',
    listing.data.summaries[0].summary_source === 'listing' && listing.data.summaries[0].summary === 'contains: c1, c2',
    JSON.stringify(listing.data.summaries[0]),
  );

  const leaf = await call('describe_project', { project_id: 'leaf-files' });
  check(
    'leaf folder falls back to a file listing',
    leaf.data.summaries[0].summary_source === 'listing' && leaf.data.summaries[0].summary === 'contains: a.py, b.py',
    JSON.stringify(leaf.data.summaries[0]),
  );

  const none = await call('describe_project', { project_id: 'truly-empty' });
  check(
    'summary is none only when nothing applies',
    none.data.summaries[0].summary === null && none.data.summaries[0].summary_source === 'none',
    JSON.stringify(none.data.summaries[0]),
  );
});
fs.rmSync(sumRoot, { recursive: true, force: true });

for (const line of log) console.log(line);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
