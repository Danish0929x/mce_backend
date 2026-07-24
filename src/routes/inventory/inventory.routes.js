import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  listSupplies,
  createSupply,
  updateSupply,
  archiveSupply,
  adjustSupply,
  listSupplyHistory,
  getInventorySpending,
} from '../../controllers/inventory/inventory.controller.js';

const router = Router();
router.use(requireAuth);

// Supply items (non-fertilizer inventory).
router.get('/supplies', listSupplies);
router.post('/supplies', createSupply);
router.patch('/supplies/:id', updateSupply);
router.delete('/supplies/:id', archiveSupply);

// Stock operations + history.
router.post('/supplies/:id/adjust', adjustSupply);
router.get('/supplies/:id/history', listSupplyHistory);

// Cross-inventory spend rollup.
router.get('/spending', getInventorySpending);

export default router;
