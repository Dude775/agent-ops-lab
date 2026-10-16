// Structured error type + MCP error result helper.
// Every tool failure is reported as a machine-readable JSON body with a stable
// `code`, never as a crash.

export const ERROR_CODES = Object.freeze({
  UNKNOWN_PROJECT: 'UNKNOWN_PROJECT',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  NOT_FOUND: 'NOT_FOUND',
  TOO_LARGE: 'TOO_LARGE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  INTERNAL: 'INTERNAL',
});

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** Wrap any thrown value into a structured, machine-readable MCP error result. */
export function toErrorResult(err) {
  const code = err instanceof AppError ? err.code : ERROR_CODES.INTERNAL;
  const message = err && err.message ? String(err.message) : 'Unexpected error';
  const body = { error: code, message };
  if (err && err.details !== undefined) body.details = err.details;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
}

/** Successful tool result: JSON text (for every client) + structuredContent (for typed clients). */
export function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
