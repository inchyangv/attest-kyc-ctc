import type { InputHTMLAttributes, ReactNode } from 'react';

const inputCls = 'h-9 w-full rounded-sm border border-line bg-sunk px-3 text-[13px] text-fg-strong placeholder:text-fg-subtle transition-colors hover:border-line-strong focus:border-mint disabled:opacity-50';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputCls} ${className}`} {...rest} />;
}

/** Label above, hint (format, "optional") right-aligned in mono, both on one 16px line. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex h-4 items-center justify-between text-xs font-medium leading-4 text-fg-muted">
        <span>{label}</span>{hint && <span className="mono text-[11px] font-normal text-fg-subtle">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
