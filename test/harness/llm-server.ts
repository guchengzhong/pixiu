import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"

export type Hit = {
  url: string
  body: Record<string, unknown>
}

export type Usage = {
  input: number
  output: number
}

export type Match = (hit: Hit) => boolean

type QueueOptions = {
  match?: Match
  wait?: PromiseLike<unknown>
  delayMs?: number
}

type RawChunk = unknown | { raw: string }

type QueuedResponse =
  | { type: "text"; text: string; reasoning?: string; usage?: Usage; wait?: PromiseLike<unknown>; delayMs?: number }
  | {
      type: "tool"
      id: string
      name: string
      input: unknown
      splitArgs?: boolean
      reasoning?: string
      usage?: Usage
      wait?: PromiseLike<unknown>
      delayMs?: number
    }
  | { type: "raw"; chunks: RawChunk[]; done: boolean; hang?: boolean; reset?: boolean; wait?: PromiseLike<unknown>; delayMs?: number }
  | { type: "stream_error"; message: string; wait?: PromiseLike<unknown>; delayMs?: number }
  | { type: "hang"; wait?: PromiseLike<unknown>; delayMs?: number }
  | { type: "reset"; wait?: PromiseLike<unknown>; delayMs?: number }
  | { type: "http_error"; status: number; body: unknown }

type QueueEntry = {
  item: QueuedResponse
  match?: Match
}

type Waiter = {
  count: number
  resolve(): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

export type FakeLLMServer = {
  url: string
  hits: Hit[]
  calls(): number
  inputs(): Record<string, unknown>[]
  pending(): number
  wait(count: number, options?: { timeoutMs?: number }): Promise<void>
  text(text: string, options?: QueueOptions & { reasoning?: string; usage?: Usage }): void
  tool(
    name: string,
    input: unknown,
    options?: QueueOptions & { id?: string; splitArgs?: boolean; reasoning?: string; usage?: Usage },
  ): void
  raw(chunks: RawChunk[], options?: QueueOptions & { done?: boolean; hang?: boolean; reset?: boolean }): void
  streamError(message?: string, options?: QueueOptions): void
  hang(options?: QueueOptions): void
  reset(options?: QueueOptions): void
  error(status: number, body: unknown, options?: QueueOptions): void
  close(): Promise<void>
}

export async function createFakeLLMServer(): Promise<FakeLLMServer> {
  const queue: QueueEntry[] = []
  const hits: Hit[] = []
  const waits: Waiter[] = []
  const sockets = new Set<Socket>()
  let toolSequence = 0
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not found" }))
      return
    }

    const body = await readJson(request)
    const hit = { url: request.url, body }
    hits.push(hit)
    notifyWaiters(hits, waits)
    const next = takeNext(queue, hit) ?? { type: "text", text: "FINAL: ok" }
    if (next.type === "http_error") {
      response.writeHead(next.status, { "content-type": "application/json" })
      response.end(JSON.stringify(next.body))
      return
    }

    await writeSSE(response, next)
  })

  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to start fake LLM server")

  const enqueue = (item: QueuedResponse, options: QueueOptions = {}) => {
    const entry: QueueEntry = { item }
    if (options.match !== undefined) entry.match = options.match
    queue.push(entry)
  }

  const withWait = <T extends QueuedResponse>(item: T, options: QueueOptions) => {
    if ("wait" in item && options.wait !== undefined) item.wait = options.wait
    if ("delayMs" in item && options.delayMs !== undefined) item.delayMs = options.delayMs
    return item
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    hits,
    calls() {
      return hits.length
    },
    inputs() {
      return hits.map((hit) => cloneJsonObject(hit.body))
    },
    pending() {
      return queue.length
    },
    wait(count: number, options: { timeoutMs?: number } = {}) {
      if (hits.length >= count) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { count, resolve, reject }
        if (options.timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            removeWaiter(waits, waiter)
            reject(new Error(`Timed out waiting for ${count} LLM request(s); saw ${hits.length}`))
          }, options.timeoutMs)
        }
        waits.push(waiter)
      })
    },
    text(text: string, options: QueueOptions & { reasoning?: string; usage?: Usage } = {}) {
      const item: QueuedResponse = withWait({ type: "text", text }, options)
      if (options.reasoning !== undefined) item.reasoning = options.reasoning
      if (options.usage !== undefined) item.usage = options.usage
      enqueue(item, options)
    },
    tool(
      name: string,
      input: unknown,
      options: QueueOptions & { id?: string; splitArgs?: boolean; reasoning?: string; usage?: Usage } = {},
    ) {
      toolSequence += 1
      const item: QueuedResponse = withWait({ type: "tool", id: options.id ?? `call_${toolSequence}`, name, input }, options)
      if (options.splitArgs !== undefined) item.splitArgs = options.splitArgs
      if (options.reasoning !== undefined) item.reasoning = options.reasoning
      if (options.usage !== undefined) item.usage = options.usage
      enqueue(item, options)
    },
    raw(chunks: RawChunk[], options: QueueOptions & { done?: boolean; hang?: boolean; reset?: boolean } = {}) {
      const item: QueuedResponse = withWait({ type: "raw", chunks, done: options.done ?? true }, options)
      if (options.hang !== undefined) item.hang = options.hang
      if (options.reset !== undefined) item.reset = options.reset
      enqueue(item, options)
    },
    streamError(message = "{not-json", options: QueueOptions = {}) {
      enqueue(withWait({ type: "stream_error", message }, options), options)
    },
    hang(options: QueueOptions = {}) {
      enqueue(withWait({ type: "hang" }, options), options)
    },
    reset(options: QueueOptions = {}) {
      enqueue(withWait({ type: "reset" }, options), options)
    },
    error(status: number, body: unknown, options: QueueOptions = {}) {
      enqueue({ type: "http_error", status, body }, options)
    },
    close() {
      rejectWaiters(waits, new Error("fake LLM server closed"))
      return closeServer(server, sockets)
    },
  }
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) return {}
  const parsed = JSON.parse(text)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function takeNext(queue: QueueEntry[], hit: Hit) {
  const index = queue.findIndex((entry) => !entry.match || entry.match(hit))
  if (index === -1) return undefined
  const [entry] = queue.splice(index, 1)
  return entry?.item
}

function notifyWaiters(hits: Hit[], waits: Waiter[]) {
  for (const waiter of [...waits]) {
    if (hits.length < waiter.count) continue
    removeWaiter(waits, waiter)
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.resolve()
  }
}

function rejectWaiters(waits: Waiter[], error: Error) {
  for (const waiter of [...waits]) {
    removeWaiter(waits, waiter)
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.reject(error)
  }
}

function removeWaiter(waits: Waiter[], waiter: Waiter) {
  const index = waits.indexOf(waiter)
  if (index !== -1) waits.splice(index, 1)
}

function cloneJsonObject(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

async function writeSSE(response: ServerResponse, item: Exclude<QueuedResponse, { type: "http_error" }>) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  send(response, { choices: [{ delta: { role: "assistant" } }] })
  await waitFor(item)

  switch (item.type) {
    case "text":
      if (item.reasoning) send(response, { choices: [{ delta: { reasoning_content: item.reasoning } }] })
      send(response, { choices: [{ delta: { content: item.text } }] })
      send(response, finishChunk("stop", item.usage))
      done(response)
      return
    case "tool": {
      if (item.reasoning) send(response, { choices: [{ delta: { reasoning_content: item.reasoning } }] })
      const args = JSON.stringify(item.input)
      send(response, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: item.id,
                  type: "function",
                  function: { name: item.name, arguments: "" },
                },
              ],
            },
          },
        ],
      })
      for (const part of item.splitArgs ? splitInHalf(args) : [args]) {
        send(response, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } }] })
      }
      send(response, finishChunk("tool_calls", item.usage))
      done(response)
      return
    }
    case "raw":
      for (const chunk of item.chunks) sendRaw(response, chunk)
      if (item.reset) {
        response.destroy(new Error("fake LLM connection reset"))
        return
      }
      if (item.hang) return
      if (item.done) done(response)
      else response.end()
      return
    case "stream_error":
      response.write(`data: ${item.message}\n\n`)
      response.end()
      return
    case "hang":
      return
    case "reset":
      response.destroy(new Error("fake LLM connection reset"))
      return
  }
}

async function waitFor(item: { wait?: PromiseLike<unknown>; delayMs?: number }) {
  if (item.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, item.delayMs))
  if (item.wait) await item.wait
}

function send(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function sendRaw(response: ServerResponse, value: RawChunk) {
  if (isRawLine(value)) response.write(value.raw)
  else send(response, value)
}

function isRawLine(value: RawChunk): value is { raw: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "raw" in value && typeof value.raw === "string")
}

function finishChunk(reason: string, usage?: Usage) {
  return {
    choices: [{ delta: {}, finish_reason: reason }],
    ...(usage ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } } : {}),
  }
}

function done(response: ServerResponse) {
  response.write("data: [DONE]\n\n")
  response.end()
}

function splitInHalf(value: string) {
  const index = Math.max(1, Math.floor(value.length / 2))
  return [value.slice(0, index), value.slice(index)].filter(Boolean)
}

function closeServer(server: Server, sockets: Set<Socket>) {
  return new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy()
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
