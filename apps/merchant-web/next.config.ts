import type { NextConfig } from 'next';

const merchantBasePath = process.env['NEXT_PUBLIC_MERCHANT_BASE_PATH'] ?? '';
if (merchantBasePath !== '' && merchantBasePath !== '/console') {
  throw new Error('NEXT_PUBLIC_MERCHANT_BASE_PATH must be empty or /console');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(merchantBasePath ? { basePath: merchantBasePath } : {}),
  transpilePackages: ['@h5cs/contracts', '@h5cs/database', '@h5cs/domain', '@h5cs/ui'],
  allowedDevOrigins: process.env.NODE_ENV === 'production' ? [] : ['127.0.0.1'],
};

export default nextConfig;
