import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** Key–value row as on an explorer detail page: fixed label column, hairline between rows. */
export function DetailRow({ label, hint, children, wide }:
  { label: ReactNode; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-divider py-2.5 text-sm last:border-b-0 sm:flex-row sm:gap-4">
      <dt className={`flex shrink-0 items-center gap-1.5 font-medium text-fg-muted ${wide ? 'sm:w-52' : 'sm:w-40'}`}>
        {hint
          ? <Icon name="info" size={16} className="shrink-0 text-fg-subtle" aria-label={hint} />
          : <span className="w-4 shrink-0" aria-hidden />}
        <span title={hint}>{label}</span>
      </dt>
      <dd className="min-w-0 flex-1 font-medium text-fg-strong">{children}</dd>
    </div>
  );
}

export function DetailList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`divide-y-0 ${className}`}>{children}</dl>;
}
