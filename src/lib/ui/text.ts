/** First non-empty line of a body, trimmed for a one-line preview. */
export function previewOf(bodyText: string | null, max = 120): string {
  if (!bodyText) return ''
  const line = bodyText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
