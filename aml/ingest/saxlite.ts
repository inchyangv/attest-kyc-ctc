/**
 * Small selected-element tree API over a well-formedness-checking XML parser.
 * Only matching subtrees are retained. Comments are never parsed as real entries.
 * This is not XML-schema validation; source-specific fields are checked by loader.ts.
 */
import { readFileSync } from 'node:fs';
import { SaxesParser } from 'saxes';

export interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: El[];
  text: string;
}

/** Walks a file and yields every element with the given tag */
export type XmlInput = string | { xml: string };
export async function streamElements(path: XmlInput, tag: string, cb: (el: El) => void): Promise<void> {
  const src = typeof path === 'string' ? readFileSync(path, 'utf8') : path.xml;
  const parser = new SaxesParser({ xmlns: true });
  const stack: El[] = [];
  parser.on('doctype', () => { throw new Error('sanctions DTD is forbidden'); });
  parser.on('opentag', node => {
    if (!stack.length && node.local !== tag) return;
    const el: El = { tag: node.local, attrs: Object.fromEntries(Object.values(node.attributes).map(a => [a.local, a.value])), kids: [], text: '' };
    if (stack.length) stack[stack.length - 1].kids.push(el);
    stack.push(el);
  });
  const append = (text: string) => { if (stack.length) stack[stack.length - 1].text += text; };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => {
    const el = stack.pop();
    if (!el) return;
    el.text = el.text.trim();
    if (!stack.length) cb(el);
  });
  parser.write(src).close();
}

// Accessors
export const self = (el: El) => el.text;
export const attr = (el: El, name: string) => el.attrs[name] ?? '';
export const direct = (el: El, tag: string) => el.kids.filter(k => k.tag === tag);

/** Text of a direct child with this tag */
export function text(el: El, tag: string): string {
  for (const k of el.kids) if (k.tag === tag) return k.text;
  return '';
}

/** el > parentTag > childTag */
export function children(el: El, parentTag: string, childTag: string): El[] {
  const out: El[] = [];
  for (const p of el.kids) if (p.tag === parentTag) for (const c of p.kids) if (c.tag === childTag) out.push(c);
  return out;
}
