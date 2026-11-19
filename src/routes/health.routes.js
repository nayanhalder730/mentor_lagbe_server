import { Router } from 'express';
import { isDatabaseConnected } from '../config/db.js';

const router = Router();

router.get('/', async (req, res) => {
  const databaseConnected = await isDatabaseConnected();

  res.status(databaseConnected ? 200 : 503).json({
    success: databaseConnected,
    status: databaseConnected ? 'ok' : 'degraded',
    database: databaseConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

export default router;
