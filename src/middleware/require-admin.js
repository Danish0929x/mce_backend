import { User } from '../models/User.js';

/**
 * Gate internal Griffon-staff routes — brief §3.2.
 *
 * Must run **after** requireAuth. The role is read from the database on
 * every call rather than trusted from the JWT: a token issued before a role
 * was revoked would otherwise keep working until it expired.
 *
 * Responds 404 rather than 403 so the existence of admin routes isn't
 * advertised to ordinary planters probing the API.
 */
export async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.user.sub).select('role');
    if (user?.role !== 'admin') {
      return res.status(404).json({ error: 'not_found' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
