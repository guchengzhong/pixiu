type Writer = Pick<typeof process.stdout, "write"> & { isTTY?: boolean }

export type TerminalOptions = {
  stdout?: Writer
  noColor?: boolean
  forceColor?: boolean
  width?: number
  accentColor?: string
}

export type Terminal = ReturnType<typeof createTerminal>

const DEFAULT_ACCENT_COLOR = "#3B8EEA"
const MAX_FRAME_WIDTH = 112
const FRAME_SAFE_MARGIN = 4

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  white: "\x1b[97m",
  black: "\x1b[30m",
  gray: "\x1b[90m",
}

export function createTerminal(options: TerminalOptions = {}) {
  const stdout = options.stdout ?? process.stdout
  const color =
    options.forceColor === true ||
    (!options.noColor && process.env.NO_COLOR === undefined && Boolean(stdout.isTTY))
  const width = Math.max(40, options.width ?? process.stdout.columns ?? 80)
  const accent = rgbAnsi(options.accentColor ?? DEFAULT_ACCENT_COLOR)
  const paint = (code: string, value: string) => (color && value ? `${code}${value}${ANSI.reset}` : value)
  return {
    color,
    width,
    accentColor: normalizeHexColor(options.accentColor ?? DEFAULT_ACCENT_COLOR),
    bold: (value: string) => paint(ANSI.bold, value),
    dim: (value: string) => paint(ANSI.dim, value),
    red: (value: string) => paint(ANSI.red, value),
    green: (value: string) => paint(ANSI.green, value),
    blue: (value: string) => paint(accent, value),
    white: (value: string) => paint(ANSI.white, value),
    black: (value: string) => paint(ANSI.black, value),
    cyan: (value: string) => paint(accent, value),
    gray: (value: string) => paint(ANSI.gray, value),
  }
}

export function panelWidthForTerminal(width: number) {
  const safeWidth = Math.max(40, width - FRAME_SAFE_MARGIN)
  return Math.max(40, Math.min(safeWidth, MAX_FRAME_WIDTH))
}

export function oneLine(value: string, maxChars: number) {
  const text = stripAnsi(value).replace(/\s+/g, " ").trim()
  return truncateVisual(text, maxChars)
}

export function stripAnsi(input: string) {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

export function displayWidth(input: string) {
  let width = 0
  for (const char of stripAnsi(input)) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) continue
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue
    if (isCombining(codePoint)) continue
    width += isWide(codePoint) ? 2 : 1
  }
  return width
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KB`
  const mib = kib / 1024
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MB`
}

export function table(rows: string[][], options: { header?: boolean } = {}) {
  if (!rows.length) return ""
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell))
    })
  }
  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, index) => (index === row.length - 1 ? cell : `${cell}${" ".repeat(Math.max(1, (widths[index] ?? 0) - displayWidth(cell) + 2))}`))
        .join("")
        .trimEnd()
      if (!options.header || rowIndex !== 0) return line
      const underline = widths.map((width, index) => "-".repeat(index === widths.length - 1 ? width : width + 2)).join("").trimEnd()
      return `${line}\n${underline}`
    })
    .join("\n")
}

export function renderMarkdown(input: string, options: { terminal?: Terminal } = {}) {
  const terminal = options.terminal ?? createTerminal()
  const lines = input.replace(/\r\n?/g, "\n").split("\n")
  const rendered: string[] = []
  let inCode = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      rendered.push(terminal.gray(line.trimEnd()))
      continue
    }
    if (inCode) {
      rendered.push(line)
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      if (rendered.length && rendered[rendered.length - 1] !== "") rendered.push("")
      rendered.push(terminal.bold(heading[2]!.trim()))
      continue
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/)
    if (bullet) {
      rendered.push(`${bullet[1] ?? ""}- ${bullet[2]}`)
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      rendered.push(terminal.gray(`| ${quote[1] ?? ""}`))
      continue
    }
    if (/^\|(.+\|)+\s*$/.test(line)) {
      rendered.push(line.trim())
      continue
    }
    rendered.push(line)
  }
  return rendered.join("\n")
}

export function box(title: string, bodyLines: string[], options: { width?: number; terminal?: Terminal } = {}) {
  const terminal = options.terminal ?? createTerminal()
  const width = Math.max(40, Math.min(options.width ?? terminal.width, 100))
  const innerWidth = width - 4
  const titleText = title ? ` ${title} ` : ""
  const top = terminal.blue(`+${titleText}${"-".repeat(Math.max(0, width - titleText.length - 2))}+`)
  const bottom = terminal.blue(`+${"-".repeat(width - 2)}+`)
  const lines = bodyLines.flatMap((line) => wrapLine(line, innerWidth))
  return [
    top,
    ...lines.map((line) => `${terminal.blue("|")} ${line}${" ".repeat(Math.max(0, innerWidth - displayWidth(line)))} ${terminal.blue("|")}`),
    bottom,
  ].join("\n")
}

export function panel(title: string, rows: string[][], options: { width?: number; terminal?: Terminal; dividerColumn?: number } = {}) {
  const terminal = options.terminal ?? createTerminal()
  const width = panelWidthForTerminal(options.width ?? terminal.width)
  const dividerColumn = Math.max(18, Math.min(options.dividerColumn ?? 35, width - 24))
  const rightWidth = width - dividerColumn - 5
  const titleBody = title ? truncateVisual(stripAnsi(title), Math.max(0, width - 8)) : ""
  const titleText = titleBody ? ` ${titleBody} ` : ""
  const top = [
    terminal.blue("┏━━━"),
    titleText ? terminal.white(terminal.bold(titleText)) : "",
    terminal.blue(`${"━".repeat(Math.max(0, width - displayWidth(titleText) - 5))}┓`),
  ].join("")
  const bottom = terminal.blue(`┗${"━".repeat(width - 2)}┛`)
  const body = rows.map(([left = "", right = ""]) => {
    const leftText = padVisual(truncateVisual(left, dividerColumn - 1), dividerColumn - 1)
    const rightText = padVisual(truncateVisual(right, rightWidth), rightWidth)
    return `${terminal.blue("┃")} ${leftText}${terminal.blue("┃")} ${rightText} ${terminal.blue("┃")}`
  })
  return [top, ...body, bottom].join("\n")
}

export function divider(width: number, terminal?: Terminal) {
  const line = "━".repeat(Math.max(1, width))
  return terminal ? terminal.blue(line) : line
}

function padVisual(value: string, width: number) {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`
}

function truncateVisual(value: string, width: number) {
  if (displayWidth(value) <= width) return value
  const plain = stripAnsi(value)
  let output = ""
  let current = 0
  const target = Math.max(0, width - 3)
  for (const char of plain) {
    const codePoint = char.codePointAt(0)
    const charWidth = codePoint === undefined || isCombining(codePoint) ? 0 : isWide(codePoint) ? 2 : 1
    if (current + charWidth > target) break
    output += char
    current += charWidth
  }
  return `${output}...`
}

function wrapLine(line: string, width: number) {
  if (!line) return [""]
  const chunks: string[] = []
  let rest = stripAnsi(line)
  while (displayWidth(rest) > width) {
    const chunk = truncateVisual(rest, width + 3).replace(/\.\.\.$/, "")
    chunks.push(chunk)
    rest = rest.slice(chunk.length)
  }
  chunks.push(rest)
  return chunks
}

function normalizeHexColor(value: string) {
  const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/)
  return match ? `#${match[1]!.toUpperCase()}` : DEFAULT_ACCENT_COLOR
}

function rgbAnsi(value: string) {
  const normalized = normalizeHexColor(value)
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  return `\x1b[38;2;${red};${green};${blue}m`
}

function isCombining(codePoint: number) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  )
}

function isWide(codePoint: number) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  )
}
