process.stdin.setEncoding("utf8")

const mode = process.env.MINICODE_FAKE_MCP_MODE ?? "echo"

if (mode === "stderr-exit") {
  process.stderr.write("fake mcp boom stderr\n")
  process.exit(3)
}

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === "tools/list") {
      if (mode === "hang") continue
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: toolsForMode(),
          },
        })}\n`,
      )
    }
    if (request.method === "tools/call") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.params.arguments })}\n`)
    }
  }
})

function toolsForMode() {
  if (mode === "collision") {
    return [
      { name: "bad name", description: "First bad name" },
      { name: "bad@name", description: "Second bad name" },
    ]
  }
  return [
    {
      name: "echo",
      description: "Echo input",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ]
}
