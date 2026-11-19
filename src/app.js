import express from 'express';
import cors from 'cors';
import healthRoutes from './routes/health.routes.js';
import userRoutes from './routes/user.routes.js';
import tuitionRoutes, {
  adminTuitionRouter,
} from './routes/tuition.routes.js';
import applicationRoutes from './routes/application.routes.js';
import paymentRoutes, {
  paymentWebhookRouter,
  adminPaymentRouter,
} from './routes/payment.routes.js';
import { notFoundHandler } from './middleware/not-found.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';

const app = express();

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
  })
);

// Simple request logger: method, path, status code, and duration.
app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startedAt;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
});

// Stripe signs the raw request body, so this route must be mounted before the
// global JSON parser. All other routes keep using express.json() unchanged.
app.use(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  paymentWebhookRouter
);

app.use(express.json());

app.use('/api/health', healthRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tuitions', tuitionRoutes);
app.use('/api/admin/tuitions', adminTuitionRouter);
app.use('/api/applications', applicationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/payments', adminPaymentRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
