import React from 'react'

export default {
  logo: <span>Makinari Docs</span>,
  project: {
    link: 'https://github.com/makinari/api',
  },
  docsRepositoryBase: 'https://github.com/makinari/api/tree/main',
  footer: {
    text: `© ${new Date().getFullYear()} Makinari.`,
  },
  sidebar: {
    defaultMenuCollapseLevel: 1,
    autoCollapse: false,
  },
  navigation: {
    prev: true,
    next: true,
  },
  toc: {
    float: true,
    title: "On this page",
  },
  darkMode: true,
  nextThemes: {
    defaultTheme: 'system'
  },
  useNextSeoProps() {
    return {
      titleTemplate: '%s – Makinari Docs'
    }
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta property="og:title" content="Makinari Docs" />
      <meta property="og:description" content="Complete documentation for the Makinari platform" />
    </>
  )
} 