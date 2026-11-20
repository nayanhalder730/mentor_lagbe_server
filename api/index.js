import app from '../src/app.js';
import { connectToDatabase } from '../src/config/db.js';
import { createServerlessHandler } from '../src/serverless-handler.js';

export default createServerlessHandler({
  app,
  connectToDatabase,
  onConnectionError() {
    // Deliberately generic: MongoDB errors may contain host details.
    console.error('Database initialization failed for serverless request');
  },
});
