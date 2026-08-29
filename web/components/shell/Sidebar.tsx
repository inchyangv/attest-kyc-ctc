'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, CreditcoinMark, type IconName } from '@/components/ui/Icon';
import { Mark, Wordmark } from '@/components/ui/Logo';
import { CONTRACTS, addressUrl } from '@/lib/links';

export const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Screening', icon: 'shield' },
  { href: '/onchain', label: 'On-chain state', icon: 'cube' },
  { href: '/design', label: 'Design system', icon: 'swatch' },
];

function NavItem({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}
      className={`flex h-12 items-center gap-3 rounded-md px-2 text-base transition-colors ${
        active ? 'bg-surface text-fg-strong' : 'text-fg hover:text-link'}`}>
      <Icon name={icon} className={active ? 'text-fg-strong' : 'text-fg-muted'} />
      <span className="flex-1">{label}</span>
      {active && <Icon name="chevron" size={18} className="text-fg-muted" />}
    </Link>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Sidebar() {
  const path = usePathname();
  return (
    <div className="hidden w-[232px] shrink-0 border-r border-divider lg:block">
    <aside className="sticky top-0 flex h-screen flex-col px-4 py-5">
      <Link href="/" className="mb-6 flex items-center gap-2.5 px-2 text-fg-strong">
        <Mark size={30} />
        <Wordmark />
      </Link>

      <nav className="flex flex-col gap-1">
        {NAV.map(n => <NavItem key={n.href} {...n} active={n.href === '/' ? path === '/' : path.startsWith(n.href)} />)}
      </nav>

      <div className="mt-8">
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">Contracts</div>
        <ul className="flex flex-col gap-0.5">
          {CONTRACTS.map(c => (
            <li key={c.name}>
              <a href={addressUrl(c.chain, c.address)} target="_blank" rel="noreferrer"
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg-strong group-hover:text-link">{c.name}</span>
                  <span className="block font-mono text-[11px] text-fg-muted">{c.chain} · {short(c.address)}</span>
                </span>
                <Icon name="external" size={14} className="text-fg-subtle group-hover:text-link" />
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto border-t border-divider px-2 pt-4 text-xs text-fg-muted">
        <div className="flex items-center gap-1.5 text-fg">
          <CreditcoinMark size={13} className="text-fg-strong" /> Built on Creditcoin
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
    <div className="flex items-center gap-1 overflow-x-auto border-b border-divider px-3 py-2 whitespace-nowrap lg:hidden">
      <Link href="/" className="mr-2 flex items-center gap-2 px-1 text-fg-strong"><Mark size={24} /><Wordmark compact /></Link>
      {NAV.map(n => {
        const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={`rounded-md px-2.5 py-1.5 text-sm font-medium ${active ? 'bg-surface text-fg-strong' : 'text-fg-muted'}`}>
            {n.label}
          </Link>
        );
      })}
    </div>
  );
}
