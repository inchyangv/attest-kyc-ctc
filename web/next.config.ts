import type { NextConfig } from 'next';
import path from 'node:path';

/**
 * aml/ and pipeline/ are NodeNext modules at the repository root, so their internal imports
 * carry the `.js` extension. The bundler has to resolve those back to `.ts` for the web app to
 * share the source as-is. We do not copy the files: a copy drifts from the original.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), '..'),
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    resolveAlias: { '@aml': '../aml', '@pipeline': '../pipeline' },
  },
  webpack: (config) => {
    // aml/ and pipeline/ sit above web/. Their packages (ethers) must resolve from web/node_modules,
    // the only node_modules the Vercel build installs.
    config.resolve.modules = [path.join(process.cwd(), 'node_modules'), 'node_modules'];
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
