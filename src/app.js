import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { isDev } from './config/env.js';
import { notFound, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth/auth.routes.js';
import dashboardRoutes from './routes/dashboard/dashboard.routes.js';
import diagnosisRoutes from './routes/diagnosis/diagnosis.routes.js';
import fertilizerRoutes from './routes/fertilizer/fertilizer.routes.js';
import healthRoutes from './routes/health.routes.js';
import inventoryRoutes from './routes/inventory/inventory.routes.js';
import laborRoutes from './routes/labor/labor.routes.js';
import plantationRoutes from './routes/plantations/plantations.routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  // 6mb covers ~4mb base64 images (3mb raw) + JSON envelope for diagnosis scans.
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (isDev) app.use(morgan('dev'));

  app.use('/api/v1/health', healthRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/plantations', plantationRoutes);
  app.use('/api/v1/dashboard', dashboardRoutes);
  app.use('/api/v1/fertilizer', fertilizerRoutes);
  app.use('/api/v1/inventory', inventoryRoutes);
  app.use('/api/v1/labor', laborRoutes);
  app.use('/api/v1/diagnosis', diagnosisRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
