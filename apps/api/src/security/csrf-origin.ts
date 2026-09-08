import { type NextFunction, type Request, type Response } from 'express';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfOriginProtection(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!unsafeMethods.has(req.method) || !hasSessionCookie(req)) return next();
  if (requestOriginMatches(req.get('origin'), configuredWebOrigin()))
    return next();
  return res.status(403).json({
    code: 'CSRF_ORIGIN_REJECTED',
    message: 'Request origin is not allowed.',
  });
}

export function requestOriginMatches(
  origin: string | undefined,
  configuredOrigin: string | undefined,
) {
  if (!origin || !configuredOrigin) return false;
  try {
    return new URL(origin).origin === new URL(configuredOrigin).origin;
  } catch {
    return false;
  }
}

export function configuredWebOrigin() {
  return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
}

function hasSessionCookie(req: Request) {
  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'pe_session';
  const prefix = `${cookieName}=`;
  return (
    req.headers.cookie
      ?.split(';')
      .some((value) => value.trim().startsWith(prefix)) ?? false
  );
}
