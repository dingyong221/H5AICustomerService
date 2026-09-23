import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@h5cs/database', '@h5cs/ui'],
  allowedDevOrigins: process.env.NODE_ENV === 'production' ? [] : ['127.0.0.1'],
};

export default nextConfig;
