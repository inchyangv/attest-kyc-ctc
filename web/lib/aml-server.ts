/**
 * Server-only AML engine. Shared v3 provenance/freshness validation and content-based reload.
 * The source XML is never parsed per request. Invalid replacement fails closed.
 */
import 'server-only';
import { join } from 'node:path';
import { IndexEngineCache } from '@aml/index-cache.js';
import type { SanctionsUse } from '@aml/provenance.js';
const cache = new IndexEngineCache();

export function getEngine(use: Extract<SanctionsUse, 'screen' | 'issuance'> = 'screen') {
  return cache.get(join(process.cwd(), 'data', 'sanctions-index.json.gz'), process.env.EVIDENCE_HMAC_KEY ?? '', process.env.EVIDENCE_KEY_ID ?? 'web-k1', use);
}
