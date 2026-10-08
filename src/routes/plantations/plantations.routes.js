import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  addPlot,
  create,
  deletePlot,
  mine,
  updateMine,
  updatePlot,
} from '../../controllers/plantations/plantations.controller.js';

const router = Router();

// Every route in this file requires a valid access token.
router.use(requireAuth);

router.post('/', create);
router.get('/mine', mine);
router.patch('/mine', updateMine);
router.post('/mine/plots', addPlot);
router.patch('/mine/plots/:id', updatePlot);
router.delete('/mine/plots/:id', deletePlot);

export default router;
