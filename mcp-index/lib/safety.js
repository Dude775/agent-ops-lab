import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';

const SEGMENT_SPLIT = /[\\/]+/;

/** True when any path segment, the basename, or the extension is on the deny list. */
export function isDenied(absPath) {
  const lower = String(absPath).toLowerCase();
  const segments = lower.split(SEGMENT_SPLIT).filter(Boolean);
  for (const seg of segments) {
    if (config.denySegmentNames.includes(seg)) return true;
  }
  const base = segments[segments.length - 1] || '';
  const ext = path.extname(base);
  if (ext && config.denyExtensions.includes(ext)) return true;
  return false;
}

/** True when `child` is `parent` itself or lives under it (lexical check). */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

let _rootReal = null;
/** realpath of the locked root (handles the root itself being a link). */
export function rootReal() {
  if (_rootReal === null) {
    try {
      _rootReal = fs.realpathSync(config.root);
    } catch {
      _rootReal = config.root;
    }
  }
  return _rootReal;
}

/**
 * True only when the resolved (symlink/junction-followed) location stays inside
 * the root and is not deny-listed. Used to skip reparse points that would
 * otherwise let listing/search walk outside the root.
 */
export function isRealInsideRoot(absPath) {
  let real;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return false;
  }
  return isInside(rootReal(), real) && !isDenied(real);
}

/**
 * Resolve a user-supplied path against a base directory and enforce every guard:
 *  - must be a non-empty string with no NUL bytes
 *  - must stay inside `baseDir`
 *  - must stay inside the locked root
 *  - must not touch the deny list
 *  - when `mustExist`, must exist; symlinks are realpath-checked against root
 * Returns the absolute path.
 */
export function resolveInside(baseDir, userPath, { mustExist = false, forWrite = false } = {}) {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'path must be a non-empty string');
  }
  if (userPath.includes('\0')) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, 'path must not contain NUL bytes');
  }
  if (forWrite) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'this server is read-only');
  }

  const resolved = path.resolve(baseDir, userPath);
  if (!isInside(baseDir, resolved)) {
    throw new AppError(ERROR_CODES.PATH_OUTSIDE_ROOT, 'path escapes the project root', {
      path: userPath,
    });
  }
  if (!isInside(config.root, resolved)) {
    throw new AppError(ERROR_CODES.PATH_OUTSIDE_ROOT, 'path escapes the index root', {
      path: userPath,
    });
  }
  if (isDenied(resolved)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'path is on the deny list', {
      path: userPath,
    });
  }

  if (mustExist) {
    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'path does not exist', { path: userPath });
    }
    if (!isInside(rootReal(), real) || isDenied(real)) {
      throw new AppError(ERROR_CODES.PATH_OUTSIDE_ROOT, 'resolved path escapes the index root', {
        path: userPath,
      });
    }
    return real;
  }
  return resolved;
}

/** Best-effort check that the root itself exists and is a directory. */
export function assertRootReadable() {
  let stat;
  try {
    stat = fs.statSync(config.root);
  } catch {
    throw new AppError(ERROR_CODES.ROOT_NOT_FOUND, 'index root does not exist or is not readable', {
      root: config.root,
    });
  }
  if (!stat.isDirectory()) {
    throw new AppError(ERROR_CODES.ROOT_NOT_FOUND, 'index root is not a directory', {
      root: config.root,
    });
  }
}
