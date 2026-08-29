/**
 * Minimal XML element extractor.
 * The target tags (sdnEntry, INDIVIDUAL, ENTITY, sanctionEntity) never nest inside themselves,
 * so we slice from the opening tag to its closing tag and parse that span into a small tree.
 * This is not a general XML parser. It handles these three feeds and nothing else.
 */
import { readFileSync } from 'node:fs';

export interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: El[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, m => ENTITIES[m])
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

const localName = (t: string) => { const i = t.indexOf(':'); return i < 0 ? t : t.slice(i + 1); };

/** One element, opening tag through closing tag, as a tree */
function parseElement(src: string, start: number): { el: El; end: number } {
  const openEnd = src.indexOf('>', start);
  const head = src.slice(start + 1, openEnd);
  const selfClosing = head.endsWith('/');
  const body = selfClosing ? head.slice(0, -1) : head;
  const m = body.match(/^([^\s/>]+)/);
  const tag = localName(m ? m[1] : '');
  const attrs: Record<string, string> = {};
  for (const a of body.slice(m ? m[1].length : 0).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[localName(a[1])] = decode(a[2]);
  }
  const el: El = { tag, attrs, kids: [], text: '' };
  if (selfClosing) return { el, end: openEnd + 1 };

  let i = openEnd + 1;
  let textBuf = '';
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    textBuf += src.slice(i, lt);
    if (src.startsWith('</', lt)) {
      const ce = src.indexOf('>', lt);
      el.text = decode(textBuf).trim();
      return { el, end: ce + 1 };
    }
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const ce = src.indexOf(']]>', lt);
      textBuf += src.slice(lt + 9, ce); i = ce + 3; continue;
    }
    const r = parseElement(src, lt);
    el.kids.push(r.el);
    i = r.end;
  }
  el.text = decode(textBuf).trim();
  return { el, end: i };
}

/** Walks a file and yields every element with the given tag */
export async function streamElements(path: string, tag: string, cb: (el: El) => void): Promise<void> {
  const src = readFileSync(path, 'utf8');
  // Require whitespace, > or / after <tag, so <ENTITY does not swallow <ENTITY_ALIAS
  const open = new RegExp(`<(?:[\\w.-]+:)?${tag}(?=[\\s/>])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    const { el, end } = parseElement(src, m.index);
    cb(el);
    open.lastIndex = end;
  }
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
