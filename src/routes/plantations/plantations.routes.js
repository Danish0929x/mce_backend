import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  create,
  mine,
} from '../../controllers/plantations/plantations.controller.js';

const router = Router();

// Every route in this file requires a valid access token.
router.use(requireAuth);

router.post('/', create);
router.get('/mine', mine);

export default router;
