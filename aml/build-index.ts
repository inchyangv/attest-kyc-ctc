/**
 * Bakes a slim index holding only what screening needs.
 * Parsing 57MB of XML per request is not something a serverless function can do.
 */
import { atomicFile } from './snapshot-store.js';
import { buildIndex } from './index-format.js';
import { loadLists } from './loader.js';

const { entries, provenance } = await loadLists();
const gz = buildIndex(entries, provenance);
atomicFile('web/data/sanctions-index.json.gz', gz);
console.log(`built v3 snapshot ${provenance.snapshotId}: ${entries.length} entries, ${(gz.length / 1e6).toFixed(2)} MB gzip`);
console.log('This switches only the local web artifact, not deployed/other runtime instances.');
