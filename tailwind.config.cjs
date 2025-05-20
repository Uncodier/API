/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/nextra-theme-docs/dist/**/*.{js,jsx,ts,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'code-bg': '#f3f4f6',
        'code-bg-dark': '#374151',
        'pre-bg': '#1f2937',
        'pre-text': '#f9fafb',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
  // Configuración para evitar conflictos con Nextra
  important: false,
  prefix: 'tw-',
  corePlugins: {
    preflight: false,
  },
}