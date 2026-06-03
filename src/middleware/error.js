import { isDev } from '../config/env.js';

export function notFound(req, res, _next) {
  res.status(404).json({
    error: 'not_found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(err, _req, res, _next) {
  const status = err.status ?? 500;
  const payload = {
    error: err.code ?? 'internal_error',
    message: err.message ?? 'Something went wrong',
  };
  if (isDev) payload.stack = err.stack;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json(payload);
}
