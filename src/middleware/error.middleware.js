/**
 * Centralized error handler.
 * Logs server-side details but never exposes internal errors to clients.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  console.error('Unhandled request error:', err);

  res.status(err.status || 500).json({
    success: false,
    message: 'Internal server error',
  });
}
