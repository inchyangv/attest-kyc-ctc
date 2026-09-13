import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-mint text-mint-fg font-semibold hover:bg-mint-hover disabled:hover:bg-mint',
  secondary: 'border border-line-strong bg-surface text-fg-strong hover:border-mint hover:bg-mint-tint',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg-strong',
};
const SIZE: Record<Size, string> = {
  md: 'h-11 px-5 text-sm',
  sm: 'h-9 px-3 text-xs',
};

const base = 'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40';

export function Button({ variant = 'primary', size = 'md', className = '', children, ...rest }:
  { variant?: Variant; size?: Size; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${base} ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...rest}>{children}</button>;
}

export function LinkButton({ variant = 'secondary', size = 'md', className = '', children, ...rest }:
  { variant?: Variant; size?: Size; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={`${base} ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...rest}>{children}</a>;
}
