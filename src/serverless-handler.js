/**
 * Vercel-compatible Express handler factory.
 *
 * MongoDB is initialized once per warm serverless instance and reused across
 * invocations. A failed attempt is reset so the next invocation can retry.
 * The Express app still handles the request even if initialization fails so
 * /api/health can report the degraded state accurately.
 */
export function createServerlessHandler({
  app,
  connectToDatabase,
  onConnectionError = () => {},
}) {
  let connectionPromise = null;

  function ensureDatabase() {
    if (!connectionPromise) {
      connectionPromise = (async () => connectToDatabase())().catch((error) => {
        connectionPromise = null;
        throw error;
      });
    }

    return connectionPromise;
  }

  return async function handler(req, res) {
    try {
      await ensureDatabase();
    } catch (error) {
      onConnectionError(error);
    }

    return app(req, res);
  };
}
