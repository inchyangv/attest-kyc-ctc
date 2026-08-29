import type { InputHTMLAttributes, ReactNode } from 'react';

const inputCls = 'h-10 w-full rounded-md border-2 border-line bg-canvas px-3 text-sm font-medium text-fg-strong placeholder:font-normal placeholder:text-fg-subtle transition-colors hover:border-line-strong focus:border-focus disabled:opacity-50';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputCls} ${className}`} {...rest} />;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-xs font-medium text-fg-muted">
        <span>{label}</span>{hint && <span className="font-normal text-fg-subtle">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
