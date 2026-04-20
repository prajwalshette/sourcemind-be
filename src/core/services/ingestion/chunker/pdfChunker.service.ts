// src/services/chunker/pdfChunker.ts
import pdfParse from 'pdf-parse';
import { ParsedElement } from './documentChunker';

export async function parsePDF(buffer: Buffer): Promise<ParsedElement[]> {
  const data = await pdfParse(buffer);
  const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);
  const elements: ParsedElement[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect heading by ALL-CAPS or short line followed by blank
    // (pdfjs-dist gives you font sizes — use that for production)
    if (isHeading(line, lines[i + 1])) {
      elements.push({ type: 'heading', level: guessLevel(line), text: line });
      i++; continue;
    }

    // Detect table: line contains 2+ tab/multiple-space separators
    if (looksLikeTableRow(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && looksLikeTableRow(lines[i])) {
        tableLines.push(lines[i]); i++;
      }
      elements.push({
        type: 'table',
        text: serializeTable(tableLines),
        rawContent: tableLines.join('\n'),
      });
      continue;
    }

    // Detect list: starts with bullet chars or numbered
    if (/^[\-\•\*\d]\s/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && /^[\-\•\*\d]\s/.test(lines[i])) {
        listLines.push(lines[i]); i++;
      }
      elements.push({ type: 'list', text: listLines.join(' ') });
      continue;
    }

    // Strip page headers/footers (short lines at page boundaries)
    if (line.length < 40 && /page \d+|^\d+$/i.test(line)) {
      i++; continue; // skip
    }

    // Regular paragraph
    elements.push({ type: 'paragraph', text: line });
    i++;
  }

  return elements;
}

function serializeTable(rows: string[]): string {
  if (rows.length === 0) return '';
  const headers = rows[0].split(/\s{2,}|\t/);
  return rows.slice(1).map(row => {
    const cells = row.split(/\s{2,}|\t/);
    // "Name is John, Age is 30, City is Mumbai"
    return headers.map((h, i) => `${h.trim()} is ${cells[i]?.trim() ?? 'N/A'}`).join(', ');
  }).join('\n');
}

function looksLikeTableRow(line: string) {
  return (line.match(/\s{2,}|\t/g) ?? []).length >= 2;
}
function isHeading(line: string, next?: string) {
  return line.length < 80 && (line === line.toUpperCase() || next === '');
}
function guessLevel(line: string): number {
  if (line.length < 20) return 1;
  if (line.length < 50) return 2;
  return 3;
}