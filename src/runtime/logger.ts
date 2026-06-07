export type LogLevel = "info" | "warn" | "error"

function write(level: LogLevel, message: string) {
  const stream = level === "error" ? process.stderr : process.stdout
  stream.write(message.endsWith("\n") ? message : `${message}\n`)
}

export const logger = {
  info(message: string) {
    write("info", message)
  },
  warn(message: string) {
    write("warn", message)
  },
  error(message: string) {
    write("error", message)
  },
}

