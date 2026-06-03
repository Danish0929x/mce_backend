import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  createScan,
  listScans,
  getScan,
  deleteScan,
} from '../../controllers/diagnosis/diagnosis.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', listScans);
router.post('/scan', createScan);
router.get('/:id', getScan);
router.delete('/:id', deleteScan);

export default router;
