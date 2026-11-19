import express from 'express';
import cors from 'cors';
import healthRoutes from './routes/health.routes.js';
import userRoutes from './routes/user.routes.js';
import tuitionRoutes, {
  adminTuitionRouter,
} from './routes/tuition.routes.js';
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

app.use(express.json());

// Simple request logger: method, path, status code, and duration.
app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startedAt;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
});

app.use('/api/health', healthRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tuitions', tuitionRoutes);
app.use('/api/admin/tuitions', adminTuitionRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
