import type { ReactNode } from 'react';

/**
 * Stat strip: one panel split into equal cells by hairlines (the 1px gap shows the line colour),
 * instead of a row of floating cards. Two columns on small screens, four on large.
 */
export function Stats({ children, cols = 4, className = '' }: { children: ReactNode; cols?: 3 | 4; className?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line ${cols === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4'} ${className}`}>
      {children}
    </div>
  );
}

/** 12px label, 18px value on a fixed 24px line box, optional unit. Every cell has the same height. */
export function Stat({ label, value, sub, className = '' }:
  { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 bg-surface px-4 py-3 ${className}`}>
      <div className="truncate text-xs leading-4 text-fg-muted">{label}</div>
      <div className="mt-1 flex h-6 min-w-0 items-baseline gap-1.5 text-lg font-semibold leading-6 text-fg-strong tabular-nums">
        <span className="shrink-0">{value}</span>
        {sub && <span className="min-w-0 truncate text-xs font-normal text-fg-muted">{sub}</span>}
      </div>
    </div>
  );
}
