import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { dashboard } from '../../controllers/dashboard/dashboard.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/', dashboard);

export default router;
