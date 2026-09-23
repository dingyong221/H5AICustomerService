import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@h5cs/ui'],
  async rewrites() {
    const localApiOrigin = process.env['H5CS_DEV_PUBLIC_API_ORIGIN'];
    if (process.env.NODE_ENV === 'production' || !localApiOrigin) return [];
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4000$/u.test(localApiOrigin)) {
      throw new Error('H5CS_DEV_PUBLIC_API_ORIGIN must target the loopback development API');
    }
    return [
      {
        source: '/api/v1/public/:path*',
        destination: `${localApiOrigin}/api/v1/public/:path*`,
      },
    ];
  },
};

export default nextConfig;
