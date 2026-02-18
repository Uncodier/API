import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import { urlToMarkdownCore } from './core';

const UrlToMarkdownSchema = z.object({
  url: z.string().url().describe('The URL of the webpage to convert to Markdown'),
});

export const urlToMarkdownTool = () =>
  tool({
    name: 'url_to_markdown',
    description: 'Converts the content of a webpage URL into Markdown format. Useful for extracting text content for analysis.',
    parameters: UrlToMarkdownSchema,
    execute: async ({ url }) => {
      try {
        return await urlToMarkdownCore(url);
      } catch (error: any) {
        throw new Error(error?.message || 'Failed to convert URL to Markdown');
      }
    },
  });
