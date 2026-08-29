import type { ReactNode } from 'react';

/** Page title block: Poppins 32/500 like the explorer's "Transactions", with an optional right slot and lede. */
export function PageTitle({ children, aside, lede }: { children: ReactNode; aside?: ReactNode; lede?: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h1 className="font-display text-[32px] font-medium leading-10 tracking-tight">{children}</h1>
        {aside && <div className="flex items-center gap-2">{aside}</div>}
      </div>
      {lede && <p className="mt-2 max-w-3xl text-base leading-6 text-fg">{lede}</p>}
    </div>
  );
}

export function Section({ title, aside, lede, children, className = '' }:
  { title: ReactNode; aside?: ReactNode; lede?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-8 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium leading-6">{title}</h2>
        {aside}
      </div>
      {lede && <p className="mt-1 max-w-3xl text-sm text-fg-muted">{lede}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The black plate from the explorer home. Mint title, white copy. */
export function Plate({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg bg-plate p-6 text-plate-fg sm:p-8 ${className}`}>{children}</div>;
}
