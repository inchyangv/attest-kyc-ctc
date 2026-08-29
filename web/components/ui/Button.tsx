import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'border-2 border-line text-fg-strong hover:border-line-strong hover:text-link',
  ghost: 'text-link hover:text-link-hover',
};
const SIZE: Record<Size, string> = {
  md: 'h-10 px-3 text-base',
  sm: 'h-8 px-2.5 text-sm',
};

const base = 'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40';

export function Button({ variant = 'primary', size = 'md', className = '', children, ...rest }:
  { variant?: Variant; size?: Size; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${base} ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...rest}>{children}</button>;
}

export function LinkButton({ variant = 'secondary', size = 'md', className = '', children, ...rest }:
  { variant?: Variant; size?: Size; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={`${base} ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...rest}>{children}</a>;
}
