import { fetchHtml, extractDescription, extractTitle } from '@/lib/utils/html-utils';
import { convertHtmlToMarkdown } from '@/lib/utils/html-to-markdown';

export interface UrlToMarkdownResult {
  url: string;
  title: string;
  description: string;
  markdown: string;
}

export async function urlToMarkdownCore(url: string): Promise<UrlToMarkdownResult> {
  const html = await fetchHtml(url);
  const markdown = convertHtmlToMarkdown(html);
  const title = extractTitle(html);
  const description = extractDescription(html);

  return {
    url,
    title,
    description,
    markdown,
  };
}

