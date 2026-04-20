// src/services/chunker/mdChunker.service.ts
import { ParsedElement } from './documentChunker';

/**
 * Parse a Markdown buffer into ParsedElements.
 * Strategy (mirrors the design doc):
 *  - ## Headings  → heading element (H1=doc, H2=parent, H3=child)
 *  - ``` fences   → code element (never split inside fence)
 *  - | Tables |   → table element (header row + data rows → serialised prose)
 *  - - bullets    → list element (all items → 1 chunk)
 *  - paragraphs   → paragraph element
 */
export function parseMD(content: string): ParsedElement[] {
  const lines = content.split(/\r?\n/);
  const elements: ParsedElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Heading ────────────────────────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      elements.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // ── Fenced code block ──────────────────────────────────────────────────
    if (/^```/.test(line)) {
      const fenceLines: string[] = [];
      i++; // skip opening fence
      while (i < lines.length && !/^```/.test(lines[i])) {
        fenceLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      if (fenceLines.length > 0) {
        elements.push({ type: 'code', text: fenceLines.join('\n') });
      }
      continue;
    }

    // ── Table ──────────────────────────────────────────────────────────────
    if (/^\|/.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      const serialized = serializeMarkdownTable(tableLines);
      if (serialized) {
        elements.push({ type: 'table', text: serialized, rawContent: tableLines.join('\n') });
      }
      continue;
    }

    // ── List (- / * / +  or  1.) ───────────────────────────────────────────
    if (/^[\-\*\+]\s|^\d+\.\s/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^[\-\*\+]\s|^\d+\.\s/.test(lines[i])) {
        listItems.push(lines[i].replace(/^[\-\*\+]\s|\d+\.\s/, '').trim());
        i++;
      }
      elements.push({ type: 'list', text: listItems.join(' | ') });
      continue;
    }

    // ── Blank line ─────────────────────────────────────────────────────────
    if (!line.trim()) {
      i++;
      continue;
    }

    // ── Paragraph ──────────────────────────────────────────────────────────
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^[\-\*\+]\s|^\d+\.\s/.test(lines[i])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    if (paraLines.length > 0) {
      elements.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return elements;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a markdown table (array of pipe-separated lines) to
 * natural-language prose sentences for best embedding quality.
 * Skips the separator row (---|---).
 */
function serializeMarkdownTable(rows: string[]): string {
  const dataRows = rows.filter(r => !/^[\|\s\-:]+$/.test(r));
  if (dataRows.length < 2) return '';

  const headers = splitRow(dataRows[0]);
  return dataRows
    .slice(1)
    .map(row => {
      const cells = splitRow(row);
      // "Product is Laptop, Price is $999, Stock is 45"
      return headers.map((h, idx) => `${h} is ${cells[idx] ?? 'N/A'}`).join(', ') + '.';
    })
    .join('\n');
}

function splitRow(row: string): string[] {
  return row
    .split('|')
    .map(c => c.trim())
    .filter(Boolean);
}
