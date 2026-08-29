import type { ReactNode } from 'react';

export type Tone = 'blue' | 'green' | 'orange' | 'red' | 'gray' | 'mint';

const TONE: Record<Tone, string> = {
  blue: 'bg-accent-tint text-accent-fg',
  green: 'bg-ok-tint text-ok-fg',
  orange: 'bg-warn-tint text-warn-fg',
  red: 'bg-bad-tint text-bad-fg',
  gray: 'bg-surface-2 text-fg',
  mint: 'bg-plate text-mint',
};

const SIZE = { md: 'h-6 px-1.5 text-sm', lg: 'h-8 px-2.5 text-base font-semibold' };

/** Blockscout tag: 14px/500, 4px radius, tinted fill. `mono` for hex values, `size="lg"` for a verdict. */
export function Tag({ tone = 'gray', mono, size = 'md', className = '', children }:
  { tone?: Tone; mono?: boolean; size?: keyof typeof SIZE; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-sm font-medium leading-none ${SIZE[size]} ${mono ? 'font-mono text-[13px]' : ''} ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}
