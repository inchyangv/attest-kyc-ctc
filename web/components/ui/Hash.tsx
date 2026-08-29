'use client';

import { useState } from 'react';
import { Icon } from './Icon';

function truncate(v: string, head: number, tail: number) {
  if (v.length <= head + tail + 1) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

/** Address / hash: monospace, optional truncation, explorer link, one-click copy. */
export function Hash({ value, href, full = false, head = 8, tail = 6, copy = true, className = '' }:
  { value: string; href?: string; full?: boolean; head?: number; tail?: number; copy?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  const text = full ? value : truncate(value, head, tail);

  async function onCopy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch {}
  }

  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 ${className}`}>
      {href
        ? <a href={href} target="_blank" rel="noreferrer" title={value} className={`link font-mono text-[13px] ${full ? 'break-all' : 'truncate'}`}>{text}</a>
        : <span title={value} className={`font-mono text-[13px] ${full ? 'break-all' : 'truncate'}`}>{text}</span>}
      {copy && (
        <button type="button" onClick={onCopy} aria-label="Copy" title={done ? 'Copied' : 'Copy'}
          className={`shrink-0 rounded-sm p-0.5 transition-colors ${done ? 'text-ok' : 'text-fg-subtle hover:text-link'}`}>
          <Icon name={done ? 'check' : 'copy'} size={16} />
        </button>
      )}
    </span>
  );
}
