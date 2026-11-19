import 'dotenv/config';
import app from './app.js';
import { connectToDatabase, closeDatabase } from './config/db.js';

const parsedPort = Number(process.env.PORT);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8000;

async function startServer() {
  // Ensure MongoDB is reachable before accepting HTTP requests.
  try {
    await connectToDatabase();
  } catch (error) {
    console.error('Failed to connect to MongoDB. Server not started.');
    console.error(`Reason: ${error.message}`);
    process.exit(1);
  }

  const server = app.listen(port, () => {
    console.log(`MentorLagbe API listening on port ${port}`);
  });

  server.on('error', async (error) => {
    console.error('HTTP server error:', error.message);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`${signal} received. Shutting down...`);

    server.close(async () => {
      await closeDatabase().catch(() => {});
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});
