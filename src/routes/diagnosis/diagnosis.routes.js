import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  createScan,
  listScans,
  getScan,
  deleteScan,
  submitFeedback,
  setTreatmentTaken,
  listFollowUps,
  addTreatmentToSchedule,
} from '../../controllers/diagnosis/diagnosis.controller.js';

const router = Router();

router.use(requireAuth);

// Literal paths before the ':id' routes, or '/:id' swallows them.
router.get('/follow-ups', listFollowUps);

router.get('/', listScans);
router.post('/scan', createScan);
router.get('/:id', getScan);
router.delete('/:id', deleteScan);
router.post('/:id/feedback', submitFeedback);
router.patch('/:id/treatment-taken', setTreatmentTaken);
router.post('/:id/add-to-schedule', addTreatmentToSchedule);

export default router;
