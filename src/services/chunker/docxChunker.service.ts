// src/services/chunker/docxChunker.ts
import mammoth from 'mammoth';
import { ParsedElement } from './documentChunker';

export async function parseDOCX(buffer: Buffer): Promise<ParsedElement[]> {
  // Use raw messages API to get structural info
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;
  const elements: ParsedElement[] = [];

  // Parse the HTML mammoth gives us
  const tagPattern = /<(h[1-3]|p|table|ul|ol|pre)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, tag, content] = match;
    const text = content.replace(/<[^>]+>/g, '').trim();
    if (!text) continue;

    if (tag.startsWith('h')) {
      elements.push({ type: 'heading', level: parseInt(tag[1]), text });
    } else if (tag === 'table') {
      elements.push({ type: 'table', text: serializeHtmlTable(content), rawContent: content });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [...content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim());
      elements.push({ type: 'list', text: items.join(' | ') });
    } else if (tag === 'pre') {
      elements.push({ type: 'code', text }); // never split code
    } else {
      elements.push({ type: 'paragraph', text });
    }
  }
  return elements;
}

function serializeHtmlTable(tableHtml: string): string {
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rows.length < 2) return '';

  const headers = [...rows[0][1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim());

  return rows.slice(1).map(row => {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());
    // Natural language sentence: "Product is Laptop, Price is $999, Stock is 45"
    return headers.map((h, i) => `${h} is ${cells[i] ?? 'N/A'}`).join(', ') + '.';
  }).join('\n');
}