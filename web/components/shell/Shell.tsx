import type { ReactNode } from 'react';
import { Header } from './Sidebar';
import { CreditcoinMark } from '@/components/ui/Icon';
import { CC3_EXPLORER } from '@/lib/links';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Header />
      <main id="main-content" className="site-main" tabIndex={-1}>{children}</main>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-semibold text-fg-strong">Proofmark</span>
            <span>Identity verification for digital assets.</span>
          </div>
          <a href={CC3_EXPLORER} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-mint">
            <CreditcoinMark size={15} /> Creditcoin <span className="network-label">Testnet</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
