import nextra from 'nextra'
import { getNextJsCorsConfig } from './cors.config.js'

const withNextra = nextra({
  contentDirBasePath: '/',
  defaultShowCopyCode: true,
  staticImage: true,
  mdxOptions: {
    remarkPlugins: [],
    rehypePlugins: []
  }
})

// Obtener la configuración CORS y loggear para depuración
console.log('[NEXT-CONFIG] Cargando configuración CORS desde cors.config.js');
const corsConfig = getNextJsCorsConfig();
console.log(`[NEXT-CONFIG] Configuración CORS cargada con ${corsConfig.length} entradas`);

// You can include other Next.js configuration options here, in addition to Nextra settings:
export default withNextra({
  reactStrictMode: true,
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000', 'localhost:3001', '192.168.87.25:3001', '192.168.87.34:3001', '192.168.87.64:3001', '192.168.87.79:3001', 'localhost:3456']
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
    COMPOSIO_PROJECT_API_KEY: process.env.COMPOSIO_PROJECT_API_KEY || 'du48sq2qy07vkyhm8v9v8g',
    TEMPORAL_SERVER_URL: process.env.TEMPORAL_SERVER_URL,
    TEMPORAL_CLOUD_API_KEY: process.env.TEMPORAL_CLOUD_API_KEY
  },
  async headers() {
    console.log('[NEXT-CONFIG] Generando headers para Next.js');
    
    // Configuración para desarrollo y producción
    const baseHeaders = [
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
        // Configuración CORS explícita para localhost:3456 (desarrollo local)
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: 'http://localhost:3456' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With' },
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Max-Age', value: '86400' },
          { key: 'Vary', value: 'Origin' }
        ]
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
    ];
    
    // Añadir configuración CORS de cors.config.js
    const allHeaders = [...baseHeaders, ...corsConfig];
    console.log(`[NEXT-CONFIG] Total de configuraciones de headers: ${allHeaders.length}`);
    
    return allHeaders;
  }
})
