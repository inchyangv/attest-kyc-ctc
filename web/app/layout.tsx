import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/shell/Shell';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Proofmark · KYC/AML attestation for Creditcoin', template: '%s · Proofmark' },
  description: 'A Creditcoin compliance gateway: external KYC/AML credentials normalized, proven through Attestcoin, and enforced by frozen on-chain policy with no cleartext PII.',
};

export const viewport: Viewport = { themeColor: '#0d0e11', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
