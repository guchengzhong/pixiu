import { redactSecrets } from "../../shared/redact"

const INLINE_SECRET = /\b(api[_-]?key|authorization|bearer|token|secret|password)(["'\s:=]+)([^"'\s,}]+)/gi

export function redactUiText(value: unknown) {
  return redactSecrets(String(value ?? "")).replace(INLINE_SECRET, "$1$2[redacted]")
}
