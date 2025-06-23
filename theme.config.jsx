import React from 'react'

export default {
  logo: <span>Uncodie API</span>,
  project: {
    link: 'https://github.com/uncodie/api',
  },
  docsRepositoryBase: 'https://github.com/uncodie/api/tree/main',
  footer: {
    text: `© ${new Date().getFullYear()} Uncodie.`,
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
    title: "En esta página",
  },
  darkMode: true,
  nextThemes: {
    defaultTheme: 'system'
  },
  useNextSeoProps() {
    return {
      titleTemplate: '%s – Uncodie API'
    }
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta property="og:title" content="Uncodie API Documentation" />
      <meta property="og:description" content="Complete API documentation for Uncodie platform" />
    </>
  )
} 