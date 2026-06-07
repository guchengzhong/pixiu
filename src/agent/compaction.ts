import type { SessionMessage } from "../session/types"

export function approximateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

export function messageApproxTokens(message: SessionMessage) {
  return approximateTokens(JSON.stringify(message.parts))
}

export function compactMessages(
  messages: SessionMessage[],
  options: { maxApproxTokens: number; keepRecentMessages: number },
): { messages: SessionMessage[]; summary?: string } {
  let total = messages.reduce((sum, message) => sum + messageApproxTokens(message), 0)
  if (total <= options.maxApproxTokens) return { messages }

  const recent = messages.slice(-options.keepRecentMessages)
  const older = messages.slice(0, -options.keepRecentMessages)
  const summary = older
    .map((message) => `${message.role}: ${message.parts.map((part) => JSON.stringify(part)).join(" ")}`)
    .join("\n")
    .slice(0, options.maxApproxTokens * 2)
  total = recent.reduce((sum, message) => sum + messageApproxTokens(message), 0)
  return {
    messages: recent,
    summary: `Compacted ${older.length} older messages. Approx recent tokens: ${total}.\n${summary}`,
  }
}
