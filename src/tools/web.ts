import { truncateText } from "../shared/text"
import { numberField, stringField } from "./schema"
import type { ToolDefinition } from "./types"

const DEFAULT_SEARCH_URL = "https://duckduckgo.com/html/"

export function createWebTools(options: { searchBaseURL?: string } = {}): ToolDefinition[] {
  const searchBaseURL = options.searchBaseURL ?? process.env.PIXIU_WEB_SEARCH_URL ?? DEFAULT_SEARCH_URL
  return [
    {
      name: "web_fetch",
      description: "Fetch a URL and return concise text content with source metadata.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
          maxBytes: { type: "number", description: "Maximum response text bytes to return." },
        },
        required: ["url"],
      },
      async execute(input, context) {
        const url = validatedURL(stringField(input, "url"))
        const maxBytes = numberField(input, "maxBytes", context.config.outputMaxBytes)
        const accessedAt = new Date().toISOString()
        const response = await fetch(url, {
          ...(context.signal ? { signal: context.signal } : {}),
          headers: {
            accept: "text/html, text/plain, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
            "user-agent": "pixiu/0.0.0",
          },
        })
        const raw = await response.text()
        const title = extractTitle(raw)
        const text = truncateText(htmlToText(raw), maxBytes)
        return {
          ok: response.ok,
          content: [
            title ? `title: ${title}` : undefined,
            `url: ${url}`,
            `status: ${response.status}`,
            `accessedAt: ${accessedAt}`,
            "",
            text.text || "(empty response)",
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
          metadata: {
            kind: "web_fetch",
            url,
            status: response.status,
            accessedAt,
            bytes: text.bytes,
            truncated: text.truncated,
            ...(title ? { title } : {}),
            activity: {
              kind: "search",
              title: response.ok ? "Fetched page" : "Page fetch failed",
              summary: `Fetched ${title ?? url}`,
              target: url,
              status: response.ok ? "success" : "error",
              details: { status: response.status },
            },
          },
        }
      },
    },
    {
      name: "web_search",
      description: "Search the web for current information and return source URLs.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          maxResults: { type: "number", description: "Maximum results to return." },
        },
        required: ["query"],
      },
      async execute(input, context) {
        const query = stringField(input, "query")
        const maxResults = Math.max(1, Math.min(10, numberField(input, "maxResults", 5)))
        const accessedAt = new Date().toISOString()
        const url = searchURL(searchBaseURL, query)
        const response = await fetch(url, {
          ...(context.signal ? { signal: context.signal } : {}),
          headers: {
            accept: "text/html, application/json, text/plain, */*",
            "user-agent": "pixiu/0.0.0",
          },
        })
        const raw = await response.text()
        const results = parseSearchResults(raw, maxResults)
        return {
          ok: response.ok,
          content: results.length
            ? results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`).join("\n")
            : `No search results for "${query}"`,
          data: results,
          metadata: {
            kind: "web_search",
            query,
            searchURL: url,
            accessedAt,
            resultCount: results.length,
            status: response.status,
            activity: {
              kind: "search",
              title: response.ok ? "Searched web" : "Web search failed",
              summary: `Searched ${query}`,
              target: query,
              status: response.ok ? "success" : "error",
              details: { resultCount: results.length, status: response.status },
            },
          },
        }
      },
    },
  ]
}

function validatedURL(value: string) {
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${parsed.protocol}`)
  return parsed.toString()
}

function searchURL(baseURL: string, query: string) {
  const url = new URL(baseURL)
  url.searchParams.set("q", query)
  return url.toString()
}

function parseSearchResults(raw: string, maxResults: number) {
  const json = parseJsonResults(raw)
  if (json.length) return json.slice(0, maxResults)

  const results: Array<{ title: string; url: string; snippet: string }> = []
  const resultRegex = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>|<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi
  for (const match of raw.matchAll(resultRegex)) {
    const href = decodeDuckDuckGoURL(decodeEntities(stripTags(match[1] ?? "")))
    const title = decodeEntities(stripTags(match[2] ?? "")).trim()
    const snippet = decodeEntities(stripTags(match[3] ?? "")).trim()
    if (!href || !title) continue
    results.push({ title, url: href, snippet })
    if (results.length >= maxResults) break
  }
  return results
}

function parseJsonResults(raw: string) {
  try {
    const data = JSON.parse(raw) as unknown
    const list = Array.isArray(data) ? data : typeof data === "object" && data !== null && Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : []
    return list
      .map((item) => {
        if (typeof item !== "object" || item === null) return
        const record = item as Record<string, unknown>
        const title = typeof record.title === "string" ? record.title : undefined
        const url = typeof record.url === "string" ? record.url : typeof record.href === "string" ? record.href : undefined
        const snippet = typeof record.snippet === "string" ? record.snippet : typeof record.description === "string" ? record.description : ""
        if (!title || !url) return
        return { title, url, snippet }
      })
      .filter((item): item is { title: string; url: string; snippet: string } => Boolean(item))
  } catch {
    return []
  }
}

function decodeDuckDuckGoURL(value: string) {
  try {
    const parsed = new URL(value)
    const uddg = parsed.searchParams.get("uddg")
    return uddg ? new URL(uddg).toString() : parsed.toString()
  } catch {
    return value
  }
}

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? decodeEntities(stripTags(match[1] ?? "")).trim() : undefined
}

function htmlToText(value: string) {
  return decodeEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  )
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ")
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
}
