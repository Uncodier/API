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
  // Configuración adicional para CSS Modules
  webpack: (config) => {
    return config;
  }
})
