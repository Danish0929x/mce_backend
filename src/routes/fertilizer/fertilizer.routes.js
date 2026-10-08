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
  seasonCost,
  createCustomFertilizer,
} from '../../controllers/fertilizer/fertilizer.controller.js';

const router = Router();

router.use(requireAuth);

// Composite read used by the Fertilizer Schedule screen (3 tabs).
router.get('/', fertilizerOverview);

// Season cost summary card (Inventory tab, brief §5.3.3).
router.get('/season-cost', seasonCost);

// Custom fertilizers (plantation-scoped, brief §4.3).
router.post('/fertilizers', createCustomFertilizer);

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
