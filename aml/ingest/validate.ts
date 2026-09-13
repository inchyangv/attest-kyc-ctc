import { SaxesParser } from 'saxes';
import { SOURCES } from '../provenance.js';
import type { ListId } from '../types.js';

/** Reject malformed/truncated XML before the schema-specific extractor runs.
 * No DTD, external entities, network lookup or schema-validation claim. */
export function validateXml(bytes: Buffer, id: ListId): string {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, root = '';
  parser.on('doctype', () => { throw new Error('sanctions DTD is forbidden'); });
  parser.on('opentag', tag => {
    if (++depth > 64) throw new Error('sanctions XML nesting exceeds limit');
    if (depth === 1) root = tag.local;
  });
  parser.on('closetag', () => { depth--; });
  parser.write(xml).close();
  if (root !== SOURCES[id].root) throw new Error(`wrong sanctions XML root for ${id}`);
  return xml;
}
