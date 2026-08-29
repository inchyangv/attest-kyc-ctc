/**
 * Proofmark mark: a seal ring, open at the top-right until the check closes it.
 * Ink on light, mint on the black plate. Inherits `currentColor`.
 */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <path d="M27.5 10.2A13 13 0 1 1 21.5 4.4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="m10.5 16.5 4 4 9-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-display text-[17px] font-semibold leading-none tracking-tight text-fg-strong">Proofmark</span>
      {!compact && <span className="text-xs font-medium text-fg-muted">마패</span>}
    </span>
  );
}
