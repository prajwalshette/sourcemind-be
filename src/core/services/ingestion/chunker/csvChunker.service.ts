// src/services/chunker/csvChunker.ts
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { ParsedElement } from './documentChunker';

export function parseCSV(content: string): ParsedElement[] {
  const rows = parse(content, { columns: true, skip_empty_lines: true });
  return rowsToElements(rows);
}

export function parseExcel(buffer: Buffer): ParsedElement[] {
  const wb = XLSX.read(buffer);
  const elements: ParsedElement[] = [];

  for (const sheetName of wb.SheetNames) {
    // Sheet name becomes the section heading
    elements.push({ type: 'heading', level: 2, text: sheetName });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    elements.push(...rowsToElements(rows as Record<string, unknown>[]));
  }
  return elements;
}

function rowsToElements(rows: Record<string, unknown>[]): ParsedElement[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  const isWide = cols.length > 10;

  if (isWide) {
    // Group 5 rows together to avoid too many tiny chunks
    const elements: ParsedElement[] = [];
    for (let i = 0; i < rows.length; i += 5) {
      const group = rows.slice(i, i + 5);
      const text = group.map(row =>
        cols.map(c => `${c}: ${row[c] ?? ''}`).join(' | ')
      ).join('\n');
      elements.push({ type: 'table', text });
    }
    return elements;
  }

  // Narrow table: each row → 1 natural language sentence
  return rows.map(row => ({
    type: 'table' as const,
    text: cols.map(c => `${c} is ${row[c] ?? 'N/A'}`).join(', ') + '.',
  }));
}