import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  env: {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    REDIS_URL: process.env.REDIS_URL,
    PORTKEY_API_KEY: process.env.PORTKEY_API_KEY,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*;",
          },
        ],
      },
    ];
  },
  images: {
    domains: ['*'],
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

// Asignamos el puerto 3001 durante el desarrollo
if (process.env.NODE_ENV === 'development') {
  process.env.PORT = '3001';
}

export default nextConfig;
