import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@h5cs/database', '@h5cs/ui'],
};

export default nextConfig;
