/** Proofmark mark: a seal ring, open at the top-right until the check closes it. Inherits currentColor. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <path d="M27.5 10.2A13 13 0 1 1 21.5 4.4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="m10.5 16.5 4 4 9-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Wordmark: Inter semibold, tight. The mark carries the mint; the word stays in text colour. */
export function Wordmark({ compact: _compact = false }: { compact?: boolean }) {
  void _compact;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[15px] font-semibold leading-none tracking-tight text-fg-strong">Proofmark</span>
    </span>
  );
}
