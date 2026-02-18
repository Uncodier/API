import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import { urlToSitemapCore } from './core';

const UrlToSitemapSchema = z.object({
  url: z.string().url().describe('The URL of the website to extract the sitemap from'),
});

export const urlToSitemapTool = () =>
  tool({
    name: 'url_to_sitemap',
    description: 'Extracts the sitemap of a website to discover its structure and page URLs. Useful for navigation and understanding site layout.',
    parameters: UrlToSitemapSchema,
    execute: async ({ url }) => {
      try {
        return await urlToSitemapCore(url);
      } catch (error: any) {
        throw new Error(error?.message || 'Failed to extract sitemap');
      }
    },
  });
