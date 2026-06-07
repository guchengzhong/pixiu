export function truncateText(value: string, maxBytes = 20_000) {
  const bytes = Buffer.byteLength(value)
  if (bytes <= maxBytes) return { text: value, truncated: false, bytes }
  const buffer = Buffer.from(value)
  return {
    text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[truncated ${bytes - maxBytes} bytes]`,
    truncated: true,
    bytes,
  }
}

export function decodeHtmlEntities(input: string) {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

export function htmlToText(input: string) {
  return decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
}

export function xmlTag(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match ? decodeHtmlEntities(match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : undefined
}

export function xmlTags(source: string, tag: string) {
  const values: string[] = []
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi")
  for (const match of source.matchAll(regex)) {
    values.push(decodeHtmlEntities(match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()))
  }
  return values
}

export function splitRecords(source: string, tag: string) {
  const records: string[] = []
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi")
  for (const match of source.matchAll(regex)) records.push(match[0])
  return records
}
