import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  fertilizerOverview,
  markApplied,
  logStockPurchase,
  createScheduleEntry,
  updateScheduleEntry,
  skipScheduleEntry,
  adjustFertilizerInventory,
  updateFertilizerThreshold,
} from '../../controllers/fertilizer/fertilizer.controller.js';

const router = Router();

router.use(requireAuth);

// Composite read used by the Fertilizer Schedule screen (3 tabs).
router.get('/', fertilizerOverview);

// Schedule CRUD (full control).
router.post('/schedule', createScheduleEntry);
router.patch('/schedule/:id', updateScheduleEntry);
router.post('/schedule/:id/skip', skipScheduleEntry);

// Application + inventory writes.
router.post('/applications', markApplied);
router.post('/stock-purchases', logStockPurchase);

// Manual inventory operations.
router.post('/inventory/:id/adjust', adjustFertilizerInventory);
router.patch('/inventory/:id/threshold', updateFertilizerThreshold);

export default router;
