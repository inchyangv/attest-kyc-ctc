'use client';

import { useState } from 'react';
import { Icon } from './Icon';

function truncate(v: string, head: number, tail: number) {
  if (v.length <= head + tail + 1) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

/**
 * Address / hash: mono, optional truncation, outbound link, one-click copy.
 * The copy button flows inline after the text, so a wrapped full hash keeps it on its last line.
 */
export function Hash({ value, href, full = false, head = 8, tail = 6, copy = true, className = '' }:
  { value: string; href?: string; full?: boolean; head?: number; tail?: number; copy?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  const text = full ? value : truncate(value, head, tail);
  const textCls = `mono ${full ? 'break-all' : 'whitespace-nowrap'}`;

  async function onCopy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch {}
  }

  return (
    <span className={`min-w-0 leading-6 ${className}`}>
      {href
        ? <a href={href} target="_blank" rel="noreferrer" title={value} className={`link ${textCls}`}>{text}</a>
        : <span title={value} className={`${textCls} text-fg-strong`}>{text}</span>}
      {copy && (
        <button type="button" onClick={onCopy} aria-label="Copy" title={done ? 'Copied' : 'Copy'}
          className={`ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm align-[-5px] transition-colors ${done ? 'text-ok' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg-strong'}`}>
          <Icon name={done ? 'check' : 'copy'} size={14} />
        </button>
      )}
    </span>
  );
}
