import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** Issue an access + refresh token pair for an authenticated user. */
export function issueTokens(user) {
  const payload = { sub: user._id.toString(), phone: user.phone };
  const access = jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.accessTtl,
  });
  const refresh = jwt.sign({ ...payload, typ: 'refresh' }, env.jwt.secret, {
    expiresIn: env.jwt.refreshTtl,
  });
  return { access, refresh };
}

/** Verify an access token. Throws on invalid/expired. */
export function verifyAccess(token) {
  const decoded = jwt.verify(token, env.jwt.secret);
  if (decoded.typ === 'refresh') throw new Error('Wrong token type');
  return decoded;
}

/** Verify a refresh token. Throws on invalid/expired. */
export function verifyRefresh(token) {
  const decoded = jwt.verify(token, env.jwt.secret);
  if (decoded.typ !== 'refresh') throw new Error('Wrong token type');
  return decoded;
}
