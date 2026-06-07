import { MinicodeError } from "../shared/errors"
import type { JsonObject, JsonValue } from "../shared/json"
import type { JSONSchema } from "../llm/types"

function typeOf(value: JsonValue) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

export function validateToolInput(schema: JSONSchema, input: JsonObject, name: string) {
  if (schema.type === "object") {
    for (const field of schema.required ?? []) {
      if (!(field in input)) {
        throw new MinicodeError(`Tool ${name} is missing required field: ${field}`, {
          code: "TOOL_INPUT_INVALID",
        })
      }
    }
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      const value = input[field]
      if (value === undefined) continue
      if (fieldSchema.type && typeOf(value) !== fieldSchema.type) {
        throw new MinicodeError(`Tool ${name} field ${field} must be ${fieldSchema.type}, got ${typeOf(value)}`, {
          code: "TOOL_INPUT_INVALID",
        })
      }
    }
  }
  return input
}

export function stringField(input: JsonObject, key: string, fallback?: string) {
  const value = input[key]
  if (typeof value === "string") return value
  if (fallback !== undefined) return fallback
  throw new MinicodeError(`Expected string field: ${key}`, { code: "TOOL_INPUT_INVALID" })
}

export function numberField(input: JsonObject, key: string, fallback: number) {
  const value = input[key]
  return typeof value === "number" ? value : fallback
}
