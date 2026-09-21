import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@h5cs/contracts', '@h5cs/ui'],
};

export default nextConfig;
