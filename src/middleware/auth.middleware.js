import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

const JWKS_PATH = '/api/auth/jwks';
const ALLOWED_ROLES = new Set(['student', 'tutor', 'admin']);

// Reused across requests so the JWKS is not fetched for every request.
// jose handles re-fetching automatically when it sees an unknown key id.
let cachedJwks = null;
let hasWarnedAboutConfig = false;

/**
 * Resolves the Better Auth base URL from the environment.
 * Returns null when it is missing or not a valid http(s) URL.
 */
function resolveAuthConfig() {
  const configuredUrl = process.env.BETTER_AUTH_URL;

  if (typeof configuredUrl !== 'string' || configuredUrl.trim() === '') {
    return null;
  }

  const baseUrl = configuredUrl.trim().replace(/\/+$/, '');

  let parsedUrl;

  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  return {
    issuer: baseUrl,
    jwksUrl: new URL(`${baseUrl}${JWKS_PATH}`),
  };
}

/**
 * Returns a cached remote JWKS resolver for the given URL.
 * A different URL (e.g. after an environment change) gets a new resolver.
 */
function getJwksResolver(jwksUrl) {
  if (!cachedJwks || cachedJwks.key !== jwksUrl.href) {
    cachedJwks = {
      key: jwksUrl.href,
      resolver: createRemoteJWKSet(jwksUrl),
    };
  }

  return cachedJwks.resolver;
}

function sendConfigError(res) {
  if (!hasWarnedAboutConfig) {
    console.error(
      'BETTER_AUTH_URL is not configured. JWT authentication is unavailable until it is set.'
    );
    hasWarnedAboutConfig = true;
  }

  return res.status(500).json({
    success: false,
    message: 'Server authentication is not configured',
  });
}

function sendUnauthorized(res, message) {
  res.set('WWW-Authenticate', 'Bearer');

  return res.status(401).json({
    success: false,
    message,
  });
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header.
 * Returns null for missing or malformed headers.
 */
function getBearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return match ? match[1] : null;
}

/**
 * Converts verified JWT claims into the request user object.
 * Returns null when a required claim is missing or invalid.
 */
function normalizeClaims(payload) {
  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    return null;
  }

  if (typeof payload.email !== 'string' || payload.email.trim() === '') {
    return null;
  }

  if (!ALLOWED_ROLES.has(payload.role)) {
    return null;
  }

  return {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
    plan: typeof payload.plan === 'string' && payload.plan ? payload.plan : null,
  };
}

/**
 * Verifies a Better Auth JWT using the client's JWKS endpoint.
 * Attaches `req.user` only after the signature, issuer, audience, and
 * required claims have all been validated.
 */
export async function verifyToken(req, res, next) {
  const config = resolveAuthConfig();

  if (!config) {
    return sendConfigError(res);
  }

  const token = getBearerToken(req.get('authorization'));

  if (!token) {
    return sendUnauthorized(res, 'Authentication required');
  }

  try {
    const { payload } = await jwtVerify(token, getJwksResolver(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.issuer,
    });

    const user = normalizeClaims(payload);

    if (!user) {
      return sendUnauthorized(res, 'Invalid authentication claims');
    }

    req.user = user;

    return next();
  } catch (error) {
    // Signature, expiry, issuer, audience, and JWKS key errors are all
    // authentication failures. Anything else is an unexpected server error.
    if (error instanceof joseErrors.JOSEError) {
      return sendUnauthorized(res, 'Invalid or expired token');
    }

    return next(error);
  }
}

/**
 * Builds middleware that allows only the given roles.
 * A verified user must already be attached to the request by `verifyToken`.
 */
export function authorizeRoles(...roles) {
  const allowedRoles = new Set(roles);

  return function roleAuthorization(req, res, next) {
    if (!req.user) {
      return sendUnauthorized(res, 'Authentication required');
    }

    if (!allowedRoles.has(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }

    return next();
  };
}

export const verifyStudent = authorizeRoles('student');
export const verifyTutor = authorizeRoles('tutor');
export const verifyAdmin = authorizeRoles('admin');
