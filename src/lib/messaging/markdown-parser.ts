export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  
  let html = markdown;

  // Images: ![alt](url) -> <img src="url" alt="alt" style="max-width: 100%; border-radius: 8px;" />
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" style="max-width: 100%; border-radius: 8px; margin: 16px 0;" />');

  // Links: [text](url) -> <a href="url">text</a>
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color: #0066cc; text-decoration: underline;">$1</a>');

  // Bold: **text** -> <strong>text</strong>
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* -> <em>text</em>
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.*?)_/g, '<em>$1</em>');

  // Paragraphs / Newlines
  // Reemplazar saltos de línea dobles con etiquetas <p>
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs.map(p => {
    if (p.trim() === '' || p.startsWith('<img') || p.startsWith('<ul') || p.startsWith('<ol')) {
      return p;
    }
    // Saltos de línea simples -> <br />
    return `<p style="margin: 0 0 16px 0;">${p.replace(/\n/g, '<br />')}</p>`;
  }).join('');

  return html;
}

export function markdownToWhatsApp(markdown: string): string {
  if (!markdown) return '';
  
  let wa = markdown;

  // Remove Images: ![alt](url) -> usually media is sent as attachment, we can just leave the URL or remove it if attached. 
  // Let's replace with just the URL since WA might render link preview, but if it's already in media_urls it's redundant.
  // We'll leave it as URL for now or just the URL.
  wa = wa.replace(/!\[(.*?)\]\((.*?)\)/g, '$2');

  // Links: [text](url) -> text: url
  wa = wa.replace(/\[(.*?)\]\((.*?)\)/g, '$1: $2');

  // Bold: **text** -> *text*
  wa = wa.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // WhatsApp already supports *text* for bold, _text_ for italics, ~text~ for strikethrough
  // Standard Markdown italic *text* conflicts with WA bold. Standard Markdown _text_ works.
  // Wait, if WA bold is *text*, and markdown is **text**, our replace above turns **text** into *text*.
  // What about standard markdown italic *text*? It becomes WA bold. We should convert it to _text_ for WA italics.
  
  // First, convert bold: **text** -> {{{BOLD_TOKEN}}}text{{{BOLD_TOKEN}}}
  wa = wa.replace(/\*\*(.*?)\*\*/g, '{{{BOLD}}}$1{{{BOLD}}}');
  
  // Convert standard markdown italic *text* -> _text_
  wa = wa.replace(/\*([^\*]+)\*/g, '_$1_');
  
  // Restore WA bold
  wa = wa.replace(/\{\{\{BOLD\}\}\}/g, '*');

  return wa;
}
