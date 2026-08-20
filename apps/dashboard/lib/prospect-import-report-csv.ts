export function prospectImportReportCsvCell(value: unknown) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  if (/^[=+\-@]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
