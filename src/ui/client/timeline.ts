import type { TraceItem } from "./types"

export type TimelineStatus = "success" | "running" | "failed" | "blocked" | "pending"

export type ExecutionTimelineItem = {
  id: string
  title: string
  subtitle?: string
  status: TimelineStatus
  raw: TraceItem[]
}

type ParsedTrace = {
  item: TraceItem
  kind: "call" | "result" | "permission" | "other"
  toolName?: string
  input?: unknown
  result?: unknown
}

type TimelineDescription = {
  title: string
  subtitle?: string
}

export function deriveExecutionTimeline(trace: TraceItem[]): ExecutionTimelineItem[] {
  const parsed = trace.map(parseTraceItem)
  const consumed = new Set<number>()
  const timeline: ExecutionTimelineItem[] = []

  for (let index = 0; index < parsed.length; index += 1) {
    if (consumed.has(index)) continue
    const entry = parsed[index]!
    if (entry.kind === "result") {
      const callIndex = findPairIndex(parsed, consumed, index, entry.toolName, "call")
      if (callIndex >= 0) {
        consumed.add(index)
        consumed.add(callIndex)
        timeline.push(timelineItemFromPair(parsed[callIndex]!, entry))
        continue
      }
    }
    if (entry.kind === "call") {
      const resultIndex = findPairIndex(parsed, consumed, index, entry.toolName, "result")
      if (resultIndex >= 0) {
        consumed.add(index)
        consumed.add(resultIndex)
        timeline.push(timelineItemFromPair(entry, parsed[resultIndex]!))
        continue
      }
    }
    consumed.add(index)
    timeline.push(timelineItemFromSingle(entry))
  }

  return timeline
}

export function describeToolCall(toolName: string, input: unknown): TimelineDescription {
  const value = objectValue(input)
  if (toolName === "write") return fileTitle("Writing file", stringValue(value.path))
  if (toolName === "edit" || toolName === "patch") return fileTitle("Updating file", stringValue(value.path))
  if (toolName === "read") return fileTitle("Read file", stringValue(value.path))
  if (toolName === "shell") return summarizeShellCommand(stringValue(value.command), undefined, "running")
  if (toolName === "todowrite" || toolName === "todo") return description("Updated task plan", todoSubtitle(input))
  if (toolName === "skill") return { title: `Loaded skill: ${stringValue(value.name) || "skill"}` }
  if (toolName === "web_search") return { title: `Searching web: ${stringValue(value.query) || "query"}` }
  if (toolName === "web_fetch") return { title: `Fetched page: ${stringValue(value.url) || "url"}` }
  return { title: `Ran tool: ${toolName}` }
}

export function describeToolResult(toolName: string, result: unknown, failed: boolean): TimelineDescription {
  const value = objectValue(result)
  const metadata = objectValue(value.metadata)
  const content = stringValue(value.content)
  const path = stringValue(metadata.path) || pathFromContent(content)
  const state = failed ? "failed" : "success"
  if (toolName === "write") return fileTitle(failed ? "File write failed" : "Updated file", path)
  if (toolName === "edit" || toolName === "patch") return fileTitle(failed ? "File update failed" : "Updated file", path)
  if (toolName === "read") return fileTitle(failed ? "Read failed" : "Read file", path)
  if (toolName === "shell") return summarizeShellCommand(commandSubtitle(result), result, state)
  if (toolName === "todowrite" || toolName === "todo") return description(failed ? "Task plan update failed" : "Updated task plan", todoSubtitle(result))
  if (toolName === "skill") return description(failed ? "Skill load failed" : "Loaded skill", skillSubtitle(result))
  if (toolName === "web_search") return description(failed ? "Web search failed" : "Completed web search", sourceSubtitle(result))
  if (toolName === "web_fetch") return description(failed ? "Page fetch failed" : "Fetched page", sourceSubtitle(result))
  return { title: failed ? `Tool failed: ${toolName}` : `Ran tool: ${toolName}` }
}

export function timelineStatusMarker(status: TimelineStatus) {
  if (status === "success") return "✓"
  if (status === "running") return "●"
  if (status === "failed") return "✕"
  if (status === "blocked") return "!"
  return "○"
}

function parseTraceItem(item: TraceItem): ParsedTrace {
  if (item.kind === "permission" || item.title === "permission") return { item, kind: "permission" }
  const callName = item.title.match(/^tool\s+(.+)$/)?.[1]?.trim()
  if (callName) return { item, kind: "call", toolName: callName, input: parseJson(item.detail) }
  const resultMatch = item.title.match(/^(ok|failed)\s+(.+)$/)
  if (resultMatch?.[2]) {
    return {
      item,
      kind: "result",
      toolName: resultMatch[2].trim(),
      result: parseJson(item.detail),
    }
  }
  return { item, kind: "other" }
}

function findPairIndex(parsed: ParsedTrace[], consumed: Set<number>, index: number, toolName: string | undefined, kind: "call" | "result") {
  if (!toolName) return -1
  for (let offset = 1; offset < parsed.length; offset += 1) {
    for (const candidateIndex of [index - offset, index + offset]) {
      if (candidateIndex < 0 || candidateIndex >= parsed.length || consumed.has(candidateIndex)) continue
      const candidate = parsed[candidateIndex]
      if (candidate?.kind === kind && candidate.toolName === toolName) return candidateIndex
    }
  }
  return -1
}

function timelineItemFromPair(call: ParsedTrace, result: ParsedTrace): ExecutionTimelineItem {
  const failed = result.item.failed === true
  const toolName = result.toolName ?? call.toolName ?? "tool"
  const description = toolName === "shell"
    ? summarizeShellCommand(stringValue(objectValue(call.input).command) ?? commandSubtitle(result.result), result.result, failed ? "failed" : "success")
    : describeToolResult(toolName, result.result, failed)
  const callDescription = describeToolCall(call.toolName ?? result.toolName ?? "tool", call.input)
  return timelineItem(`${call.item.id}:${result.item.id}`, description.title, failed ? "failed" : "success", [call.item, result.item], description.subtitle ?? callDescription.subtitle)
}

function timelineItemFromSingle(entry: ParsedTrace): ExecutionTimelineItem {
  if (entry.kind === "call") {
    const description = describeToolCall(entry.toolName ?? "tool", entry.input)
    return timelineItem(entry.item.id, description.title, "running", [entry.item], description.subtitle)
  }
  if (entry.kind === "result") {
    const description = describeToolResult(entry.toolName ?? "tool", entry.result, entry.item.failed === true)
    return timelineItem(entry.item.id, description.title, entry.item.failed ? "failed" : "success", [entry.item], description.subtitle)
  }
  if (entry.kind === "permission") {
    const parsed = parseJson(entry.item.detail)
    const permission = permissionDescription(parsed, entry.item.failed === true)
    return timelineItem(entry.item.id, permission.title, permission.status, [entry.item], permission.subtitle)
  }
  if (entry.item.title === "Run finished") {
    return timelineItem(entry.item.id, "Run completed", entry.item.failed ? "failed" : "success", [entry.item], runFinishedSubtitle(entry.item.detail))
  }
  return timelineItem(entry.item.id, entry.item.failed ? "Activity failed" : entry.item.title, entry.item.failed ? "failed" : "pending", [entry.item], compactDetail(entry.item.detail))
}

function timelineItem(id: string, title: string, status: TimelineStatus, raw: TraceItem[], subtitle: string | undefined): ExecutionTimelineItem {
  return {
    id,
    title,
    status,
    raw,
    ...(subtitle ? { subtitle } : {}),
  }
}

function parseJson(value: string | undefined) {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

type ShellIntentState = "running" | "success" | "failed"

export function summarizeShellCommand(command: string | undefined, result?: unknown, state: ShellIntentState = "success"): TimelineDescription {
  const normalized = command?.trim()
  if (!normalized) return fallbackCommandSummary(undefined, state)
  const tokens = splitShellWords(normalized)
  const base = basename(tokens[0])
  const outputPath = extractRedirectOutput(normalized)
  const resultText = resultContent(result)

  if (base === "wc" && tokens.includes("-l")) {
    const file = extractPathFromCommand(normalized, "wc") ?? tokenAfter(tokens, "-l")
    const count = lineCountFromResult(resultText)
    return stateSummary(state, "Counting lines", "Counted lines", "Failed to count lines", count && file ? `${count} lines in ${file}` : file)
  }

  if (base === "cat") {
    return stateSummary(state, "Reading file with shell", "Read file with shell", "Failed to read file with shell", extractPathFromCommand(normalized, "cat"))
  }

  if (base === "grep") {
    return stateSummary(state, "Searching text", "Searched text", "Failed to search text", extractPathFromCommand(normalized, "grep"))
  }

  if (base === "python" || base === "python3") {
    const importedPackage = pythonImportPackage(normalized)
    if (importedPackage) {
      return stateSummary(state, "Checking Python package", "Checked Python package", "Failed to check Python package", importedPackage)
    }
    return stateSummary(state, "Running Python script", "Ran Python script", "Failed to run Python script", outputPath ? `Generated/updated ${outputPath}` : pythonScriptPath(tokens))
  }

  if (base === "which") {
    const checked = tokens[1]
    return stateSummary(state, "Checking command availability", "Checked command availability", "Command not available", checked)
  }

  if (base === "pdftotext") {
    return stateSummary(state, "Extracting PDF text", "Extracted PDF text", "Failed to extract PDF text", outputPath ?? extractPathFromCommand(normalized, "pdftotext"))
  }

  if (isInstallCommand(tokens)) {
    return stateSummary(state, "Installing package", "Installed package", "Failed to install package", installPackageSubtitle(tokens))
  }

  if (base === "mkdir") return stateSummary(state, "Creating directory", "Created directory", "Failed to create directory", extractPathFromCommand(normalized, "mkdir"))
  if (base === "cp") return stateSummary(state, "Copying file", "Copied file", "Failed to copy file", copyMoveSubtitle(tokens))
  if (base === "mv") return stateSummary(state, "Moving file", "Moved file", "Failed to move file", copyMoveSubtitle(tokens))
  if (base === "rm") return stateSummary(state, "Removing file", "Removed file", "Failed to remove file", extractPathFromCommand(normalized, "rm") ?? compactCommand(normalized))

  return fallbackCommandSummary(normalized, state)
}

export function extractCommandIntent(command: string, result?: unknown, state: ShellIntentState = "success") {
  return summarizeShellCommand(command, result, state)
}

export function extractPathFromCommand(command: string, commandName?: string) {
  const tokens = splitShellWords(command)
  const baseIndex = commandName ? tokens.findIndex((token) => basename(token) === commandName) : 0
  const start = baseIndex >= 0 ? baseIndex + 1 : 1
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token === "--" || token.startsWith("-")) continue
    if (isShellOperator(token)) break
    if (isRedirectToken(token)) {
      index += 1
      continue
    }
    return token
  }
  return undefined
}

function fileTitle(prefix: string, path: string | undefined) {
  return {
    title: path ? `${prefix}: ${path}` : prefix,
  }
}

function description(title: string, subtitle: string | undefined): TimelineDescription {
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
  }
}

function stateSummary(state: ShellIntentState, runningTitle: string, successTitle: string, failedTitle: string, subtitle: string | undefined) {
  if (state === "running") return description(runningTitle, subtitle)
  if (state === "failed") return description(failedTitle, subtitle)
  return description(successTitle, subtitle)
}

function fallbackCommandSummary(command: string | undefined, state: ShellIntentState) {
  if (state === "running") return description("Running command", compactCommand(command))
  if (state === "failed") return description("Command failed", compactCommand(command))
  return description("Command completed", compactCommand(command))
}

function splitShellWords(command: string) {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    if (char === "&" && command[index + 1] === "&") {
      if (current) {
        words.push(current)
        current = ""
      }
      words.push("&&")
      index += 1
      continue
    }
    if (char === "|" && command[index + 1] === "|") {
      if (current) {
        words.push(current)
        current = ""
      }
      words.push("||")
      index += 1
      continue
    }
    if (char === ">") {
      if (current) {
        if (/^[12]$/.test(current)) {
          current += ">"
          words.push(current)
          current = ""
          continue
        }
        words.push(current)
        current = ""
      }
      words.push(">")
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}

function basename(value: string | undefined) {
  return String(value ?? "").split(/[\\/]/).filter(Boolean).pop() ?? ""
}

function tokenAfter(tokens: string[], token: string) {
  const index = tokens.indexOf(token)
  return index >= 0 ? tokens[index + 1] : undefined
}

function lineCountFromResult(content: string | undefined) {
  return content?.match(/(?:^|\n)\s*(\d+)(?:\s+\S+)?(?:\n|$)/)?.[1]
}

function resultContent(result: unknown) {
  if (typeof result === "string") return result
  return stringValue(objectValue(result).content)
}

function pythonImportPackage(command: string) {
  return command.match(/\bpython3?\s+-c\s+(?:"|')\s*import\s+([A-Za-z0-9_.-]+)/)?.[1]
}

function pythonScriptPath(tokens: string[]) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.startsWith("-")) {
      if (token === "-c") return undefined
      continue
    }
    return token
  }
  return undefined
}

function extractRedirectOutput(command: string) {
  const tokens = splitShellWords(command)
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === ">" || tokens[index] === "1>" || tokens[index] === "2>") return tokens[index + 1]
  }
  return undefined
}

function isInstallCommand(tokens: string[]) {
  const first = basename(tokens[0])
  return (first === "apt-get" && tokens.includes("install")) || (first === "brew" && tokens.includes("install")) || (first === "pip" && tokens.includes("install"))
}

function installPackageSubtitle(tokens: string[]) {
  const installIndex = tokens.indexOf("install")
  if (installIndex < 0) return undefined
  const packages: string[] = []
  for (let index = installIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (isShellOperator(token)) break
    if (isRedirectToken(token)) {
      index += 1
      continue
    }
    if (token.startsWith("-")) continue
    packages.push(token)
  }
  return packages.length ? packages.slice(0, 3).join(", ") : undefined
}

function copyMoveSubtitle(tokens: string[]) {
  const paths = commandArgs(tokens).filter((token) => token && !token.startsWith("-"))
  if (paths.length >= 2) return `${paths[0]} → ${paths[paths.length - 1]}`
  return paths[0]
}

function compactCommand(command: string | undefined) {
  if (!command) return undefined
  const oneLine = command.replace(/\s+/g, " ").trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

function commandSubtitle(result: unknown) {
  const metadata = objectValue(objectValue(result).metadata)
  return stringValue(metadata.command) ?? commandFromContent(stringValue(objectValue(result).content))
}

function commandFromContent(content: string | undefined) {
  if (!content) return undefined
  return content.match(/command:\s*(.+)/i)?.[1]?.trim()
}

function pathFromContent(content: string | undefined) {
  if (!content) return undefined
  return content.match(/(?:Changed|No changes for)\s+([^\n]+)/)?.[1]?.trim()
}

function commandArgs(tokens: string[]) {
  const args: string[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (isShellOperator(token)) break
    if (isRedirectToken(token)) {
      index += 1
      continue
    }
    args.push(token)
  }
  return args
}

function isRedirectToken(token: string) {
  return token === ">" || token === "1>" || token === "2>" || token === ">>" || token === "1>>" || token === "2>>"
}

function isShellOperator(token: string) {
  return token === "&&" || token === "||" || token === "|" || token === ";"
}

function permissionDescription(value: unknown, failed: boolean): { title: string; status: TimelineStatus; subtitle?: string } {
  const detail = objectValue(value)
  const action = stringValue(detail.action) ?? stringValue(detail.permissionAction)
  const request = objectValue(detail.request)
  const tool = stringValue(request.tool) ?? stringValue(detail.tool)
  const scope = stringValue(detail.scope)
  const title = action === "deny" || failed ? "Permission denied" : action === "allow" ? "Permission allowed" : "Permission decision"
  return {
    title,
    status: action === "deny" || failed ? "blocked" : action === "allow" ? "success" : "pending",
    ...([tool, scope].filter(Boolean).join(" · ") ? { subtitle: [tool, scope].filter(Boolean).join(" · ") } : {}),
  }
}

function runFinishedSubtitle(detail: string | undefined) {
  const status = detail?.match(/status:\s*([^\n]+)/)?.[1]?.trim()
  const finishReason = detail?.match(/finishReason:\s*([^\n]+)/)?.[1]?.trim()
  if ((status === "done" || status === "idle") && finishReason === "stop") return "Finished normally"
  if (status || finishReason) return [status ? `status ${status}` : undefined, finishReason ? `finish ${finishReason}` : undefined].filter(Boolean).join(" · ")
  return undefined
}

function compactDetail(detail: string | undefined) {
  if (!detail) return undefined
  const oneLine = detail.replace(/\s+/g, " ").trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

function todoSubtitle(value: unknown) {
  const metadataTodos = objectValue(objectValue(value).metadata).todos
  const directTodos = objectValue(value).todos
  const todos = Array.isArray(metadataTodos)
    ? metadataTodos
    : Array.isArray(directTodos)
      ? directTodos
      : undefined
  return todos ? `${todos.length} tasks` : undefined
}

function skillSubtitle(value: unknown) {
  const metadata = objectValue(objectValue(value).metadata)
  return stringValue(metadata.name) ?? stringValue(objectValue(value).name)
}

function sourceSubtitle(value: unknown) {
  const metadata = objectValue(objectValue(value).metadata)
  return stringValue(metadata.url) ?? stringValue(metadata.query)
}
