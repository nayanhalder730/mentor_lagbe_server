/**
 * Centralized error handler.
 * Logs server-side details but never exposes internal errors to clients.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  // Log a sanitized message only. Full error objects can carry connection
  // strings, request bodies or webhook payloads.
  console.error(
    'Unhandled request error:',
    err instanceof Error ? err.message : 'unknown error'
  );

  res.status(err.status || 500).json({
    success: false,
    message: 'Internal server error',
  });
}
