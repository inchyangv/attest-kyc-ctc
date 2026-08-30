import type { ReactNode } from 'react';

/**
 * Key–value row: fixed 176px label column, hairline between rows, 24px line box on both sides
 * so a label and the first line of its value share a baseline. A hint becomes a dotted
 * underline with a title, which keeps the label column flush.
 */
export function DetailRow({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 border-b border-divider py-2.5 last:border-b-0 sm:grid-cols-[176px_minmax(0,1fr)]">
      <dt className="text-[13px] leading-6 text-fg-muted">
        {hint
          ? <span title={hint} className="cursor-help underline decoration-fg-subtle decoration-dotted underline-offset-4">{label}</span>
          : label}
      </dt>
      <dd className="min-w-0 text-[13px] leading-6 text-fg-strong">{children}</dd>
    </div>
  );
}

export function DetailList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`panel px-4 ${className}`}>{children}</dl>;
}
