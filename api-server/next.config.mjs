import nextra from 'nextra'

const withNextra = nextra({
  contentDirBasePath: '/',
  defaultShowCopyCode: true,
  staticImage: true
})

// You can include other Next.js configuration options here, in addition to Nextra settings:
export default withNextra({
  reactStrictMode: true,
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000', 'localhost:3001', '192.168.87.25:3001', '192.168.87.34:3001', '192.168.87.64:3001', 'localhost:3456']
    }
  },
  typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors. Temporarily disabled for build.
    // !! WARN !!
    ignoreBuildErrors: true,
  },
  // Configuración para imágenes optimizadas
  images: {
    // Desactivar la optimización de imágenes en desarrollo para evitar advertencias de Sharp
    unoptimized: process.env.NODE_ENV === 'development',
  },
  // Configuración adicional para CSS Modules
  webpack: (config, { dev }) => {
    // Solución para suprimir las advertencias de binarios precompilados
    if (dev) {
      // Configurar Webpack para mostrar solo errores, no advertencias
      config.infrastructureLogging = {
        level: 'error'
      };
    }
    
    return config;
  },
  // Configuración de rutas de API
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: '/api/:path*',
      },
    ]
  },
  // Ensure environment variables are available
  env: {
    COMPOSIO_PROJECT_API_KEY: process.env.COMPOSIO_PROJECT_API_KEY || 'du48sq2qy07vkyhm8v9v8g'
  },
  async headers() {
    return [
      {
        // Aplicar estos encabezados a todas las rutas
        source: '/(.*)',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          }
        ],
      },
      {
        // Configuración específica para la ruta WebSocket
        source: '/api/agents/chat/websocket',
        headers: [
          { key: 'Connection', value: 'upgrade' },
          { key: 'Upgrade', value: 'websocket' },
          // Encabezados CORS para WebSockets
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin' }
        ]
      }
    ]
  }
})
