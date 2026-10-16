#!/usr/bin/env node
// End-to-end test: a real MCP client spawns the server over stdio against a
// temporary stub root, discovers the tools, and calls every one of them —
// including invalid input, error paths, the deny list and a client disconnect.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.js');

// ---- fixture -------------------------------------------------------------

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-index-fixture-'));
  const mk = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  mk(
    'alpha-node-app/package.json',
    JSON.stringify({ name: 'alpha-node-app', description: 'Alpha demo node app', version: '1.0.0' }, null, 2),
  );
  mk('alpha-node-app/README.md', '# Alpha Node App\nFirst line description of alpha.\n\nMore detail.\n');
  mk('alpha-node-app/CLAUDE.md', '# Claude notes for alpha\n');
  mk('alpha-node-app/src/index.js', "console.log('hello from alpha');\n");
  mk('alpha-node-app/big.txt', 'x'.repeat(2000));
  fs.mkdirSync(path.join(root, 'alpha-node-app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha-node-app', 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
  mk('alpha-node-app/id_rsa', 'PRIVATE-KEY-DO-NOT-READ\n');
  mk('alpha-node-app/.ssh/token.txt', 'ssh-token\n');

  mk('beta-helm/Chart.yaml', 'apiVersion: v2\nname: beta-helm\nversion: 0.1.0\n');
  mk('beta-helm/README.md', '# Beta Helm\nKubernetes deployment charts.\n');
  mk('beta-helm/docs/notes.md', 'This chart deploys kubernetes workloads to the cluster.\n');

  mk(
    'delta-long/package.json',
    JSON.stringify({ name: 'delta-long', description: 'D'.repeat(260), version: '1.0.0' }),
  );
  mk('delta-long/README.md', '# delta-long\nFiller.\n');

  mk('gamma-repo/.git/HEAD', 'ref: refs/heads/main\n');
  mk('gamma-repo/main.py', "print('gamma')\n");

  mk('credentials/key.txt', 'should-never-be-indexed\n');
  mk('loose-file.txt', 'not a project\n');
  return root;
}

// ---- tiny test harness ---------------------------------------------------

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

function body(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

async function call(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args || {} });
    return { result, error: null, data: body(result) };
  } catch (err) {
    return { result: null, error: err, data: null };
  }
}

// ---- run -----------------------------------------------------------------

const fixture = buildFixture();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, GENSPARK_INDEX_ROOT: fixture },
  stderr: 'pipe',
});
const client = new Client({ name: 'genspark-index-test', version: '1.0.0' });
await client.connect(transport);

// A. discovery
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
check(
  'tools/list returns the 7 documented tools',
  ['describe_project', 'get_project', 'index_status', 'list_files', 'list_projects', 'read_file', 'search_projects'].every(
    (n) => names.includes(n),
  ),
  names.join(','),
);
const templates = await client.listResourceTemplates();
check(
  'resource template genspark://project/{id} is registered',
  templates.resourceTemplates.some((t) => String(t.uriTemplate).includes('genspark://project/{id}')),
);

// B. list_projects
{
  const { data } = await call(client, 'list_projects', {});
  check('list_projects returns the 4 project dirs', data && data.total === 4, JSON.stringify(data && data.total));
  const ids = (data && data.projects.map((p) => p.id)) || [];
  check(
    'deny-listed dir credentials is not indexed',
    !ids.some((i) => i.includes('credentials')),
    ids.join(','),
  );
  check('loose files at root are not treated as projects', !ids.includes('loose-file'), ids.join(','));
}
{
  const { data } = await call(client, 'list_projects', { query: 'helm' });
  check('list_projects query filters', data && data.total === 1 && data.projects[0].id === 'beta-helm');
}

// C. get_project
{
  const { data } = await call(client, 'get_project', { project_id: 'alpha-node-app' });
  check('get_project returns a README preview', data && typeof data.readme === 'string' && data.readme.includes('Alpha'));
  const kinds = data ? data.config_files.map((c) => c.kind) : [];
  check('get_project lists config files', kinds.includes('node') && kinds.includes('claude') && kinds.includes('docs'), kinds.join(','));
  check('get_project detected_stack is an array', Array.isArray(data && data.detected_stack));
}

// D. search_projects
{
  const { data } = await call(client, 'search_projects', { query: 'kubernetes', scope: 'content' });
  check(
    'search_projects (content) finds a nested file',
    data && data.matches.some((m) => m.project_id === 'beta-helm' && m.path.includes('notes.md')),
    JSON.stringify(data && data.matches),
  );
}
{
  const { data } = await call(client, 'search_projects', { query: 'beta', scope: 'names' });
  check('search_projects (names) matches project name', data && data.total >= 1 && data.matches[0].project_id === 'beta-helm');
}

// E. list_files
{
  const { data } = await call(client, 'list_files', { project_id: 'beta-helm', glob: '**/*.md' });
  const paths = (data && data.files.map((f) => f.path)) || [];
  check('list_files glob returns markdown files', paths.includes('README.md') && paths.includes('docs/notes.md'), paths.join(','));
}
{
  const { data } = await call(client, 'list_files', { project_id: 'alpha-node-app', limit: 1 });
  check('list_files reports truncation at the limit', data && data.returned === 1 && data.truncated === true);
}

// F. read_file
{
  const { data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: 'src/index.js' });
  check('read_file returns file content', data && data.content.includes('hello from alpha') && data.encoding === 'utf-8');
}
{
  const { data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: 'big.txt', max_bytes: 10 });
  check('read_file truncates at max_bytes', data && data.truncated === true && data.content.length === 10 && data.size === 2000);
}
{
  const { data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: 'bin.dat' });
  check('read_file marks binary files', data && data.encoding === 'binary' && data.content === '');
}

// F2. describe_project
{
  const { data } = await call(client, 'describe_project', { project_id: 'alpha-node-app' });
  check(
    'describe_project single uses package.json description',
    data && data.requested === 1 && data.returned === 1 && data.unknown_ids.length === 0 &&
      data.summaries[0].summary_source === 'package.json' && data.summaries[0].summary.includes('Alpha demo'),
    JSON.stringify(data),
  );
}
{
  const { data } = await call(client, 'describe_project', { project_id: 'beta-helm' });
  check(
    'describe_project falls back to README first meaningful line',
    data && data.summaries[0].summary_source === 'readme' && data.summaries[0].summary.includes('Kubernetes'),
    JSON.stringify(data && data.summaries[0]),
  );
}
{
  const { data } = await call(client, 'describe_project', { project_id: 'gamma-repo' });
  check(
    'describe_project falls back to listing when only repo files exist',
    data && data.summaries[0].summary_source === 'listing' && data.summaries[0].summary === 'contains: main.py',
    JSON.stringify(data && data.summaries[0]),
  );
}
{
  const { data } = await call(client, 'describe_project', { project_id: 'delta-long' });
  check(
    'describe_project truncates at 200 chars',
    data && data.summaries[0].truncated === true && data.summaries[0].summary.length === 200,
    JSON.stringify(data && data.summaries[0]),
  );
}
{
  const { data } = await call(client, 'describe_project', {
    project_ids: ['alpha-node-app', 'beta-helm', 'nope', 'alpha-node-app'],
  });
  check(
    'describe_project batch dedupes, keeps order, collects unknown_ids',
    data && data.requested === 3 && data.returned === 2 && data.unknown_ids.length === 1 &&
      data.unknown_ids[0] === 'nope' && data.summaries[0].project_id === 'alpha-node-app' &&
      data.summaries[1].project_id === 'beta-helm',
    JSON.stringify(data),
  );
}
{
  const { result, data } = await call(client, 'describe_project', { project_id: 'nope' });
  check(
    'describe_project single unknown -> UNKNOWN_PROJECT',
    result && result.isError === true && data && data.error === 'UNKNOWN_PROJECT',
    JSON.stringify(data),
  );
}
{
  const { result, error } = await call(client, 'describe_project', { project_id: 'alpha-node-app', project_ids: ['beta-helm'] });
  check('describe_project rejects both args', Boolean(error) || (result && result.isError === true));
}
{
  const { result, error } = await call(client, 'describe_project', {});
  check('describe_project rejects neither arg', Boolean(error) || (result && result.isError === true));
}

// G. error paths
{
  const { result, data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: 'id_rsa' });
  check('deny-listed file returns PERMISSION_DENIED', result && result.isError === true && data && data.error === 'PERMISSION_DENIED', JSON.stringify(data));
}
{
  const { result, data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: '../../etc/passwd' });
  check('path traversal returns PATH_OUTSIDE_ROOT', result && result.isError === true && data && data.error === 'PATH_OUTSIDE_ROOT', JSON.stringify(data));
}
{
  const { result, data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: '.ssh/token.txt' });
  check('deny-listed dir returns PERMISSION_DENIED', result && result.isError === true && data && data.error === 'PERMISSION_DENIED', JSON.stringify(data));
}
{
  const { result, data } = await call(client, 'get_project', { project_id: 'does-not-exist' });
  check('unknown project returns UNKNOWN_PROJECT', result && result.isError === true && data && data.error === 'UNKNOWN_PROJECT', JSON.stringify(data));
}
{
  const { result, data } = await call(client, 'read_file', { project_id: 'alpha-node-app', path: 'no-such-file.txt' });
  check('missing file returns NOT_FOUND', result && result.isError === true && data && data.error === 'NOT_FOUND', JSON.stringify(data));
}

// H. invalid arguments (schema validation)
{
  const { result, error } = await call(client, 'list_projects', { limit: 0 });
  check('invalid argument (limit=0) is rejected, not crashed', Boolean(error) || (result && result.isError === true));
}
{
  const { error, result } = await call(client, 'search_projects', { query: '' });
  check('empty query returns an actionable error', Boolean(error) || (result && result.isError === true));
}

// I. index_status
{
  const { data } = await call(client, 'index_status', {});
  check('index_status reports the locked root and project count', data && data.root === fixture && data.project_count === 4, JSON.stringify(data));
}

// J. resource
{
  const res = await client.readResource({ uri: 'genspark://project/beta-helm' });
  const txt = res.contents[0].text;
  check('resource read returns project JSON', txt.includes('"id":"beta-helm"') || txt.includes('beta-helm'), txt.slice(0, 80));
}
{
  let errored = false;
  try {
    await client.readResource({ uri: 'genspark://project/nope' });
  } catch {
    errored = true;
  }
  check('unknown resource id errors', errored);
}

// K. client disconnect
const pid = transport.pid;
await client.close();
let exited = false;
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    process.kill(pid, 0);
  } catch {
    exited = true;
    break;
  }
}
check('server process exits after client disconnect', exited);

// ---- report --------------------------------------------------------------

fs.rmSync(fixture, { recursive: true, force: true });
for (const line of log) console.log(line);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
