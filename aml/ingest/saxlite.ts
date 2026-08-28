/**
 * 최소 XML 요소 추출기.
 * 대상 태그(sdnEntry·INDIVIDUAL·ENTITY·sanctionEntity)는 자기 자신을 중첩하지 않으므로
 * 여는 태그 → 대응 닫는 태그 구간을 잘라 작은 트리로 파싱한다.
 * 범용 XML 파서가 아니다 — 이 세 피드에 한정한다.
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

/** 요소 하나(여는 태그부터 닫는 태그까지)를 트리로 */
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

/** 파일에서 특정 태그의 요소를 순차 추출 */
export async function streamElements(path: string, tag: string, cb: (el: El) => void): Promise<void> {
  const src = readFileSync(path, 'utf8');
  // <tag 뒤에 공백/>/`/` 가 와야 한다 — <ENTITY 가 <ENTITY_ALIAS 를 잡지 않게
  const open = new RegExp(`<(?:[\\w.-]+:)?${tag}(?=[\\s/>])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    const { el, end } = parseElement(src, m.index);
    cb(el);
    open.lastIndex = end;
  }
}

// ── 접근 헬퍼 ──
export const self = (el: El) => el.text;
export const attr = (el: El, name: string) => el.attrs[name] ?? '';
export const direct = (el: El, tag: string) => el.kids.filter(k => k.tag === tag);

/** 직계 자식 중 tag 의 텍스트 (없으면 1단계 더 내려가 탐색) */
export function text(el: El, tag: string): string {
  for (const k of el.kids) if (k.tag === tag) return k.text;
  return '';
}

/** el > parentTag > childTag 목록 */
export function children(el: El, parentTag: string, childTag: string): El[] {
  const out: El[] = [];
  for (const p of el.kids) if (p.tag === parentTag) for (const c of p.kids) if (c.tag === childTag) out.push(c);
  return out;
}
