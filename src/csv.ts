/** Escape a value into one valid CSV cell. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  return /[,"\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Convert an array of flat objects to CSV using the union of all columns. */
export function objectsToCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return `${columns.map(csvEscape).join(',')}\n${rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')).join('\n')}\n`;
}
