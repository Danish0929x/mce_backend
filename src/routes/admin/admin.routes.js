import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/require-admin.js';
import { getAccuracyReport } from '../../controllers/diagnosis/diagnosis.controller.js';

/**
 * Internal Griffon-staff routes — brief §3.2.
 *
 * Mounted separately from the planter-facing API so that admin paths never
 * share a prefix with a user's own resources, and so requireAdmin can't be
 * forgotten on a new route added here.
 */
const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/diagnosis/accuracy', getAccuracyReport);

export default router;
