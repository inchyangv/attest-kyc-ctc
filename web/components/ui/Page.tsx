import type { ReactNode } from 'react';

/** Page header: eyebrow, Poppins title with `aside` on the same line, one-paragraph lede below. */
export function PageHeader({ eyebrow, title, lede, aside }:
  { eyebrow?: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-6">
      {eyebrow && <div className="mb-1.5 text-[11px] font-semibold uppercase leading-4 tracking-[0.08em] text-fg-muted">{eyebrow}</div>}
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2">
        <h1 className="font-display text-[26px] font-semibold leading-8 tracking-tight">{title}</h1>
        {aside && <div className="flex h-8 items-center gap-3">{aside}</div>}
      </div>
      {lede && <p className="mt-1.5 max-w-2xl text-sm leading-5 text-fg-muted">{lede}</p>}
    </header>
  );
}

/** Section: 15px title and a right-aligned aside on one 24px line; optional lede; 12px to the body. */
export function Section({ title, aside, lede, children, className = '' }:
  { title: ReactNode; aside?: ReactNode; lede?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-8 ${className}`}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-semibold leading-6">{title}</h2>
        {aside && <div className="flex items-center gap-2 text-xs text-fg-muted">{aside}</div>}
      </div>
      {lede && <p className="mt-1 max-w-3xl text-[13px] leading-5 text-fg-muted">{lede}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Small uppercase label above a list. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-[11px] font-semibold uppercase leading-4 tracking-[0.08em] text-fg-muted ${className}`}>{children}</div>;
}
