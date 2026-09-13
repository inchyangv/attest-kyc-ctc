import { createServer } from 'node:http';
import type { loadRosterBundle } from './roster-bundle.js';

/** Local replica endpoint: load/validate one immutable bundle before listening. No RPC, key,
 * file paths in requests, raw bundle export, latest alias or access log. Not production ingress. */
export function rosterProofServer(bundle: ReturnType<typeof loadRosterBundle>) {
  const metadata = bundle.metadata();
  let window = Date.now(), requests = 0;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': status === 200 ? 'private, max-age=31536000, immutable' : 'no-store',
        Connection: 'close' });
      res.end(JSON.stringify(body));
    };
    if (Date.now() - window >= 60_000) { window = Date.now(); requests = 0; }
    if (++requests > 120) { send(429, { error: 'replica request budget exceeded' }); return; }
    if (req.method !== 'GET') { send(405, { error: 'GET only' }); return; }
    if (req.headers.origin || req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      send(400, { error: 'cross-origin requests and request bodies are unsupported' }); return;
    }
    const path = req.url ?? '';
    if (path.length > 256) { send(414, { error: 'request target too long' }); return; }
    const match = /^\/v1\/rosters\/([a-f0-9]{64})\/proof\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (!match || match[1] !== metadata.contentHash) { send(404, { error: 'unknown content-addressed proof' }); return; }
    try { send(200, bundle.proof(match[2])); }
    catch { send(400, { error: 'invalid proof subject' }); }
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  return server;
}
