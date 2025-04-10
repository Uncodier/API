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
    appDir: true,
    serverActions: {
      allowedOrigins: ['localhost:3000', 'localhost:3001', '192.168.87.25:3001']
    }
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
  }
})
