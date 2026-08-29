import type { NextConfig } from 'next';
import path from 'node:path';

/**
 * aml/ 과 pipeline/ 은 저장소 루트의 NodeNext 모듈이라 내부 import 가 `.js` 확장자를 쓴다.
 * 번들러가 그것을 `.ts` 로 되짚게 해야 소스를 그대로 공유할 수 있다.
 * 사본을 만들지 않는 이유: 사본은 언젠가 원본과 갈라진다.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), '..'),
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    resolveAlias: { '@aml': '../aml', '@pipeline': '../pipeline' },
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
