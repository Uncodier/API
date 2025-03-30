import nextra from 'nextra'
 
const withNextra = nextra({
  contentDirBasePath: '/',
  defaultShowCopyCode: true,
  staticImage: true
})
 
// You can include other Next.js configuration options here, in addition to Nextra settings:
export default withNextra({
  reactStrictMode: true,
  swcMinify: true,
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
  }
})
