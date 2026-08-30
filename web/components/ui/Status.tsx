import type { ReactNode } from 'react';
import type { Tone } from './Tag';

const DOT: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', mint: 'bg-mint', gray: 'bg-fg-subtle' };
const TEXT: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', mint: 'text-mint', gray: 'text-fg-muted' };

/**
 * Status: dot + word, in the text size of its context. Used where a value must sit on the
 * same baseline as its neighbours (stat cells, verdict rows). Tables use <Tag> instead.
 */
export function Status({ tone, className = '', children }: { tone: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold ${TEXT[tone]} ${className}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
      {children}
    </span>
  );
}
