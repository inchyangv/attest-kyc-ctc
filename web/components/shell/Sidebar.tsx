'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, CreditcoinMark, type IconName } from '@/components/ui/Icon';
import { Mark, Wordmark } from '@/components/ui/Logo';
import { Eyebrow } from '@/components/ui/Page';
import { CONTRACTS, addressUrl } from '@/lib/links';

export const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: '/verify', label: 'Verify', icon: 'user' },
  { href: '/', label: 'Screening', icon: 'shield' },
  { href: '/onchain', label: 'On-chain state', icon: 'cube' },
];

const isActive = (href: string, path: string) => (href === '/' ? path === '/' : path.startsWith(href));

function NavItem({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}
      className={`relative flex h-8 items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium transition-colors ${
        active ? 'bg-surface-2 text-fg-strong' : 'text-fg-muted hover:bg-surface hover:text-fg-strong'}`}>
      {active && <span className="absolute -left-3 top-2 h-4 w-0.5 rounded-full bg-mint" aria-hidden />}
      <Icon name={icon} size={16} className={active ? 'text-mint' : 'text-fg-subtle'} />
      <span>{label}</span>
    </Link>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Sidebar() {
  const path = usePathname();
  return (
    <div className="hidden w-[232px] shrink-0 border-r border-line lg:block">
      <aside className="sticky top-0 flex h-screen flex-col px-3 py-4">
        <Link href="/" className="mb-5 flex h-8 items-center gap-2 px-2 text-fg-strong">
          <Mark size={22} className="text-mint" />
          <Wordmark />
        </Link>

        <nav className="flex flex-col gap-0.5">
          {NAV.map(n => <NavItem key={n.href} {...n} active={isActive(n.href, path)} />)}
        </nav>

        <div className="mt-7">
          <Eyebrow className="mb-1.5 px-2">Contracts</Eyebrow>
          <ul className="flex flex-col">
            {CONTRACTS.map(c => (
              <li key={c.name}>
                <a href={addressUrl(c.chain, c.address)} target="_blank" rel="noreferrer"
                  className="group flex h-11 items-center gap-2 rounded-sm px-2 transition-colors hover:bg-surface">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-4 text-fg group-hover:text-fg-strong">{c.name}</span>
                    <span className="mono mt-0.5 block truncate text-[11px] leading-4 text-fg-subtle">
                      <span className="text-fg-muted">{c.chain}</span> {short(c.address)}
                    </span>
                  </span>
                  <Icon name="external" size={14} className="shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto border-t border-line px-2 pt-4 text-[11px] leading-4 text-fg-subtle">
          <div className="flex items-center gap-1.5 text-fg-muted">
            <CreditcoinMark size={12} /> Built on Creditcoin
          </div>
          <div className="mt-1">Attestcoin Protocol · BUIDL CTC 2026</div>
        </div>
      </aside>
    </div>
  );
}

/** Compact nav for viewports without the sidebar. */
export function MobileNav() {
  const path = usePathname();
  return (
    <div className="flex h-12 items-center gap-1 overflow-x-auto border-b border-line px-3 whitespace-nowrap lg:hidden">
      <Link href="/" className="mr-3 flex items-center gap-2 px-1 text-fg-strong"><Mark size={20} className="text-mint" /><Wordmark compact /></Link>
      {NAV.map(n => {
        const active = isActive(n.href, path);
        return (
          <Link key={n.href} href={n.href} className={`flex h-8 items-center rounded-sm px-2.5 text-[13px] font-medium ${active ? 'bg-surface-2 text-fg-strong' : 'text-fg-muted'}`}>
            {n.label}
          </Link>
        );
      })}
    </div>
  );
}
