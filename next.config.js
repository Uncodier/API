import path from 'path';
import { fileURLToPath } from 'url';
import nextra from 'nextra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const withNextra = nextra({
  contentDirBasePath: '/src/content',
  mdxOptions: {
    rehypePlugins: [],
    remarkPlugins: []
  },
  defaultShowCopyCode: true
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    esmExternals: true,
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
    };
    return config;
  },
  // Configuración para el servidor
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
        ],
      },
    ];
  },
};

export default withNextra(nextConfig); 