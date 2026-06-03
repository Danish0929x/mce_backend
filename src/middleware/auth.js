import { verifyAccess } from '../services/jwt.service.js';

/**
 * Require a valid access token. Attaches `req.user = { sub, phone }` for
 * downstream handlers. Replaces Supabase RLS — every protected route uses
 * this to know who the caller is, and ownership checks happen per-resource.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({
      error: 'no_token',
      message: 'Missing Authorization header.',
    });
  }

  try {
    const decoded = verifyAccess(token);
    req.user = { sub: decoded.sub, phone: decoded.phone };
    return next();
  } catch {
    return res.status(401).json({
      error: 'invalid_token',
      message: 'Your session has expired. Please sign in again.',
    });
  }
}
