import { readFile } from "node:fs/promises"

import { MinicodeError } from "./errors"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function stripJsonComments(input: string) {
  let output = ""
  let inString = false
  let quote = ""
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        inString = false
      }
      continue
    }

    if (char === "\"" || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1
      output += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        if (input[index] === "\n") output += "\n"
        index += 1
      }
      index += 1
      continue
    }

    output += char
  }

  return output
}

export function parseJsonc<T = JsonValue>(input: string, source = "JSONC"): T {
  try {
    return JSON.parse(stripJsonComments(input)) as T
  } catch (cause) {
    throw new MinicodeError(`Invalid ${source}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      code: "CONFIG_PARSE_ERROR",
      cause,
    })
  }
}

export async function readJsoncFile<T = JsonValue>(path: string) {
  return parseJsonc<T>(await readFile(path, "utf8"), path)
}

export function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MinicodeError(`${label} must be an object`, { code: "INVALID_JSON_OBJECT" })
  }
  return value
}

export function stringifyJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}
