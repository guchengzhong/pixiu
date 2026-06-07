import { randomBytes } from "node:crypto"

const counters = new Map<string, number>()

function nextCounter(prefix: string) {
  const next = (counters.get(prefix) ?? 0) + 1
  counters.set(prefix, next)
  return next
}

export function createID(prefix: string) {
  const time = Date.now().toString(36)
  const count = nextCounter(prefix).toString(36).padStart(4, "0")
  const random = randomBytes(4).readUInt32BE().toString(36).padStart(7, "0")
  return `${prefix}_${time}_${count}_${random}`
}
