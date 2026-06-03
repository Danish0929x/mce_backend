import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

router.get('/', (_req, res) => {
  const dbState = mongoose.connection.readyState;
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const dbStatus =
    dbState === 1
      ? 'connected'
      : dbState === 2
        ? 'connecting'
        : 'disconnected';

  res.json({
    service: 'my-cardamom-estate-backend',
    status: 'ok',
    db: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

export default router;
