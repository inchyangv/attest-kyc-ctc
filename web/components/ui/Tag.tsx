import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'mint' | 'gray';

const TONE: Record<Tone, string> = {
  ok: 'bg-ok-tint text-ok',
  warn: 'bg-warn-tint text-warn',
  bad: 'bg-bad-tint text-bad',
  mint: 'bg-mint-tint text-mint',
  gray: 'bg-surface-2 text-fg',
};

const SIZE = {
  sm: 'h-5 px-1.5 text-[11px]',
  md: 'h-6 px-2 text-xs',
  lg: 'h-7 px-2.5 text-[13px] font-semibold',
};

/**
 * Tag: tinted fill, text of the same hue, 4px radius. Heights are 20 / 24 / 28 so a tag
 * sits on the same line box as 13px text (leading 20 / 24). `mono` for hex values.
 */
export function Tag({ tone = 'gray', mono, size = 'md', className = '', children }:
  { tone?: Tone; mono?: boolean; size?: keyof typeof SIZE; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-sm font-medium leading-none ${SIZE[size]} ${mono ? 'mono' : ''} ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}
