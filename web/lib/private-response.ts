import 'server-only';

/** Sensitive KYC responses, including failures, must not opt into intermediary caching. */
export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(body, { ...init, headers });
}
