import os from 'node:os';
import path from 'node:path';

function defaultRoot() {
  if (process.env.GENSPARK_INDEX_ROOT) return process.env.GENSPARK_INDEX_ROOT;
  // Generic default: a "projects" folder under the user's home.
  // Set GENSPARK_INDEX_ROOT to point at the tree you want indexed.
  return path.join(os.homedir(), 'projects');
}

function intFromEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function listFromEnv(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  serverName: 'genspark-index',
  serverVersion: '1.4.0',
  indexVersion: 1,

  // Root the server is locked to. Defaults to ~/projects; override with env.
  root: path.resolve(defaultRoot()),

  // Pagination / size caps.
  defaultProjectLimit: 50,
  maxProjectLimit: 500,
  defaultListLimit: 200,
  maxListLimit: 2000,
  defaultSearchLimit: 20,
  maxSearchLimit: 200,
  maxReadBytes: intFromEnv('GENSPARK_INDEX_MAX_BYTES', 65536, 1024, 4 * 1024 * 1024),
  maxScanEntries: intFromEnv('GENSPARK_INDEX_MAX_SCAN_ENTRIES', 200000, 2000, 5000000),
  maxContentFileBytes: intFromEnv('GENSPARK_INDEX_MAX_CONTENT_FILE_BYTES', 512 * 1024, 4096, 16 * 1024 * 1024),
  readmePreviewChars: 1500,
  snippetRadius: 80,

  // Generic credential denylist. Nothing site-specific is committed here: add
  // your own names per install with GENSPARK_INDEX_DENY_EXTRA (comma-separated).
  // Matched case-insensitively against any path segment, the basename, or an
  // added substring.
  denySegmentNames: [
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    '.ssh',
    '.aws',
    '.gnupg',
    '.netrc',
    '.npmrc',
    'id_rsa',
    'id_ed25519',
    'credentials',
    'credentials.json',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'service-account.json',
    'kubeconfig',
    ...listFromEnv('GENSPARK_INDEX_DENY_EXTRA'),
  ],
  denyExtensions: ['.pem', '.key', '.pfx', '.p12', '.keystore', '.jks', '.ppk'],
};
