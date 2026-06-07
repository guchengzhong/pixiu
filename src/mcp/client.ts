import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import { createID } from "../shared/id"
import { MinicodeError } from "../shared/errors"
import type { JsonObject, JsonValue } from "../shared/json"
import type { MCPClient, MCPTool } from "./types"

type Pending = {
  resolve(value: JsonValue): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class StdioMCPClient implements MCPClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string | number, Pending>()
  private stderr = ""

  constructor(private readonly options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) {}

  private start() {
    if (this.child) return
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
    })
    const reader = createInterface({ input: this.child.stdout })
    reader.on("line", (line) => this.handleLine(line))
    this.child.stderr.on("data", (chunk) => this.appendStderr(chunk))
    this.child.on("error", (error) => {
      this.rejectPending(new MinicodeError(`MCP server failed: ${error.message}${this.stderrSuffix()}`, { code: "MCP_SERVER_ERROR" }))
    })
    this.child.on("exit", (code, signal) => {
      const why = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
      this.child = undefined
      this.rejectPending(new MinicodeError(`MCP server exited (${why})${this.stderrSuffix()}`, { code: "MCP_SERVER_EXITED" }))
    })
  }

  stderrSummary() {
    return this.stderr.trim()
  }

  private appendStderr(chunk: Buffer | string) {
    this.stderr = `${this.stderr}${chunk.toString()}`
    if (this.stderr.length > 4_000) this.stderr = this.stderr.slice(-4_000)
  }

  private stderrSuffix() {
    const stderr = this.stderrSummary()
    return stderr ? `: ${stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" | ")}` : ""
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string) {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!("id" in message)) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new MinicodeError(String(message.error.message ?? message.error), { code: "MCP_ERROR" }))
    else pending.resolve(message.result)
  }

  private request(method: string, params?: JsonObject) {
    this.start()
    const id = createID("mcp")
    const timeoutMs = this.options.timeoutMs ?? 10_000
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MinicodeError(`MCP request timed out: ${method}${this.stderrSuffix()}`, { code: "MCP_TIMEOUT" }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child!.stdin.write(`${message}\n`)
      } catch (cause) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new MinicodeError(`Failed to write MCP request: ${cause instanceof Error ? cause.message : String(cause)}${this.stderrSuffix()}`, { code: "MCP_WRITE_FAILED" }))
      }
    })
  }

  async listTools() {
    const result: any = await this.request("tools/list")
    return (result.tools ?? result ?? []) as MCPTool[]
  }

  async callTool(name: string, input: JsonObject) {
    return this.request("tools/call", { name, arguments: input })
  }

  async close() {
    const child = this.child
    this.child = undefined
    this.rejectPending(new MinicodeError("MCP server closed", { code: "MCP_CLOSED" }))
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.stdin.destroy()
    child.kill()
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 150)
    try {
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 300))])
    } finally {
      clearTimeout(hardKill)
    }
  }
}

export class HttpMCPClient implements MCPClient {
  constructor(private readonly options: { url: string; headers?: Record<string, string>; timeoutMs?: number }) {}

  private async request(method: string, params?: JsonObject) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: createID("mcp"), method, params }),
      })
      if (!response.ok) throw new MinicodeError(`HTTP MCP failed (${response.status})`, { code: "MCP_HTTP_FAILED" })
      const json: any = await response.json()
      if (json.error) throw new MinicodeError(String(json.error.message ?? json.error), { code: "MCP_ERROR" })
      return json.result as JsonValue
    } finally {
      clearTimeout(timer)
    }
  }

  async listTools() {
    const result: any = await this.request("tools/list")
    return (result.tools ?? result ?? []) as MCPTool[]
  }

  async callTool(name: string, input: JsonObject) {
    return this.request("tools/call", { name, arguments: input })
  }
}
