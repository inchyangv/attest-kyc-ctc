import type { Metadata, Viewport } from 'next';
import { Inter, Poppins } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/shell/Shell';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-poppins', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Proofmark · KYC/AML attestation for Creditcoin', template: '%s · Proofmark' },
  description: 'Prove compliance once and carry it to every chain. Issued on Ethereum, verified on Creditcoin by Attestcoin, with zero bytes of PII on-chain.',
};

export const viewport: Viewport = { themeColor: '#0d0e11', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${poppins.variable}`}>
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
