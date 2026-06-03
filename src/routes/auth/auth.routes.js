import { Router } from 'express';
import {
  login,
  register,
  verify,
  refresh,
  me,
} from '../../controllers/auth/auth.controller.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

// Public — OTP issuance + verification.
router.post('/login', login);
router.post('/register', register);
router.post('/verify', verify);
router.post('/refresh', refresh);

// Protected — current user lookup (auto-login on app launch).
router.get('/me', requireAuth, me);

export default router;
