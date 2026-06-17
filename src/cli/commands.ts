export type ChatCommandDefinition = {
  name: `/${string}`
  description: string
  aliases?: string[]
}

export const CHAT_COMMANDS = [
  { name: "/help", description: "Show slash commands and shortcuts.", aliases: ["?"] },
  { name: "/clear", description: "Clear the terminal screen while keeping session context." },
  { name: "/compact", description: "Summarize older conversation turns while keeping recent context." },
  { name: "/paste", description: "Enter multiline input; finish with '.', cancel with /cancel." },
  { name: "/tools", description: "List available tools." },
  { name: "/session", description: "Show the active session." },
  { name: "/model", description: "Show the active model." },
  { name: "/config", description: "Show or update provider config." },
  { name: "/mcp", description: "Show MCP server status." },
  { name: "/skills", description: "List discovered skills." },
  { name: "/doctor", description: "Run local diagnostics." },
  { name: "/exit", description: "Exit chat." },
] as const satisfies ChatCommandDefinition[]

export function slashCommandNames(commands: readonly ChatCommandDefinition[] = CHAT_COMMANDS) {
  return commands.map((command) => command.name.slice(1))
}

export function formatChatHelp(commands: readonly ChatCommandDefinition[] = CHAT_COMMANDS) {
  const width = commands.reduce((max, command) => Math.max(max, command.name.length), 0)
  return [
    "Slash commands:",
    ...commands.map((command) => `${command.name.padEnd(width)}  ${command.description}`),
  ].join("\n")
}

export function slashCommandToken(input: string) {
  const leading = input.match(/^\s*/)?.[0] ?? ""
  const rest = input.slice(leading.length)
  const match = rest.match(/^\/[^\s]*/)
  if (!match) return
  return {
    leading,
    token: match[0],
    start: leading.length,
    end: leading.length + match[0].length,
  }
}

export function matchingSlashCommands(input: string, commands: readonly ChatCommandDefinition[] = CHAT_COMMANDS) {
  const token = slashCommandToken(input)
  if (!token) return []
  return commands.filter((command) => command.name.startsWith(token.token) || command.aliases?.some((alias) => alias.startsWith(token.token)))
}

export function applySlashCompletion(input: string, commandName: string) {
  const token = slashCommandToken(input)
  if (!token) return commandName
  return `${input.slice(0, token.start)}${commandName}${input.slice(token.end)}`
}
