import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Proofmark — Cross-chain KYC/AML attestation',
  description: 'Prove compliance once. Carry it to every chain. Built on Creditcoin × Attestcoin.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0b0d10] text-[#e6e8eb] antialiased">
        <header className="border-b border-white/10">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
            <a href="/" className="text-sm font-semibold tracking-tight">
              Proofmark<span className="ml-2 font-normal text-white/40">마패</span>
            </a>
            <nav className="flex gap-5 text-sm text-white/60">
              <a href="/" className="hover:text-white">Screening</a>
              <a href="/onchain" className="hover:text-white">On-chain</a>
            </nav>
            <span className="ml-auto rounded-full border border-white/15 px-3 py-1 text-xs text-white/50">
              CC3 Testnet · Sepolia
            </span>
          </div>
        </header>
        {children}
        <footer className="mt-20 border-t border-white/10 px-6 py-8 text-center text-xs text-white/35">
          BUIDL CTC 2026 Fall · Attestcoin Protocol · 온체인 개인정보 0바이트
        </footer>
      </body>
    </html>
  );
}
