// src/services/chunker/txtChunker.service.ts
import { ParsedElement } from './documentChunker';

/**
 * Parse a plain-text buffer into ParsedElements.
 * Strategy:
 *  - Lines that are ALL-CAPS or short (< 60 chars) and followed by a blank
 *    line are treated as headings.
 *  - Consecutive non-empty lines are joined into paragraphs.
 *  - Empty lines flush the current paragraph.
 */
export function parseTXT(content: string): ParsedElement[] {
  const lines = content.split(/\r?\n/);
  const elements: ParsedElement[] = [];
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    elements.push({ type: 'paragraph', text: paragraphBuffer.join(' ').trim() });
    paragraphBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    // Heading heuristic: ALL_CAPS or short line followed by blank/end
    const nextLine = lines[i + 1]?.trim() ?? '';
    if (
      line.length < 80 &&
      (line === line.toUpperCase() || nextLine === '') &&
      line.length > 2
    ) {
      flushParagraph();
      elements.push({ type: 'heading', level: line.length < 30 ? 1 : 2, text: line });
      continue;
    }

    // Bullet / numbered list item
    if (/^[\-\•\*\d]\s/.test(line)) {
      flushParagraph();
      const listItems: string[] = [line];
      while (i + 1 < lines.length && /^[\-\•\*\d]\s/.test(lines[i + 1]?.trim() ?? '')) {
        i++;
        listItems.push(lines[i].trim());
      }
      elements.push({ type: 'list', text: listItems.join(' | ') });
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();
  return elements;
}
