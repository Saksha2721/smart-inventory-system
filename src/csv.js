export function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('There is no report data to export.');
  const columns = Object.keys(rows[0]);
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return '\uFEFF' + [
    columns.map(quote).join(','),
    ...rows.map((row) => columns.map((column) => quote(row[column])).join(',')),
  ].join('\r\n');
}
