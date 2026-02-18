import * as cheerio from 'cheerio';

/**
 * Converts HTML content to Markdown
 * 
 * @param html The HTML string to convert
 * @returns The converted Markdown string
 */
export function convertHtmlToMarkdown(html: string): string {
  if (!html) return '';

  const $ = cheerio.load(html);

  // Remove scripts, styles, and other non-content elements
  $('script, style, iframe, svg, noscript, header, footer, nav').remove();

  // Helper function to process nodes
  function processNode(node: any): string {
    if (node.type === 'text') {
      return node.data.trim().replace(/\s+/g, ' ');
    }

    if (node.type === 'tag') {
      const tagName = node.name;
      const childrenContent = node.children
        .map((child: any) => processNode(child))
        .join('');

      switch (tagName) {
        case 'h1':
          return `\n# ${childrenContent}\n`;
        case 'h2':
          return `\n## ${childrenContent}\n`;
        case 'h3':
          return `\n### ${childrenContent}\n`;
        case 'h4':
          return `\n#### ${childrenContent}\n`;
        case 'h5':
          return `\n##### ${childrenContent}\n`;
        case 'h6':
          return `\n###### ${childrenContent}\n`;
        case 'p':
          return `\n${childrenContent}\n`;
        case 'br':
          return '\n';
        case 'hr':
          return '\n---\n';
        case 'ul':
          return `\n${childrenContent}\n`;
        case 'ol':
          return `\n${childrenContent}\n`;
        case 'li':
          return `\n- ${childrenContent}`;
        case 'strong':
        case 'b':
          return `**${childrenContent}**`;
        case 'em':
        case 'i':
          return `*${childrenContent}*`;
        case 'a':
          const href = $(node).attr('href');
          return href ? `[${childrenContent}](${href})` : childrenContent;
        case 'img':
          const src = $(node).attr('src');
          const alt = $(node).attr('alt') || '';
          return src ? `![${alt}](${src})` : '';
        case 'code':
          return `\`${childrenContent}\``;
        case 'pre':
          return `\n\`\`\`\n${childrenContent}\n\`\`\`\n`;
        case 'blockquote':
          return `\n> ${childrenContent}\n`;
        case 'div':
        case 'span':
        case 'section':
        case 'article':
        case 'main':
        case 'body':
        case 'html':
          return childrenContent; // Just return children content for container tags
        default:
          return childrenContent;
      }
    }

    return '';
  }

  // Start processing from body
  let markdown = processNode($('body')[0] || $.root()[0]);

  // Clean up excessive newlines
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  return markdown;
}
