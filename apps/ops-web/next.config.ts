import type { NextConfig } from 'next';

const opsBasePath = process.env['NEXT_PUBLIC_OPS_BASE_PATH'] ?? '';
if (opsBasePath !== '' && opsBasePath !== '/ops') {
  throw new Error('NEXT_PUBLIC_OPS_BASE_PATH must be empty or /ops');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(opsBasePath ? { basePath: opsBasePath } : {}),
  transpilePackages: ['@h5cs/database', '@h5cs/ui'],
  allowedDevOrigins: process.env.NODE_ENV === 'production' ? [] : ['127.0.0.1'],
};

export default nextConfig;
