import { readFile } from "node:fs/promises"

import { OpenAICompatibleClient } from "../src/llm/openai"

const config = JSON.parse(await readFile("docs/api_key.jsonl", "utf8")) as {
  url: string
  key: string
  model: string
}

const client = new OpenAICompatibleClient({ baseURL: config.url, apiKey: config.key })
const events = []
let text = ""

for await (const event of client.stream({
  model: config.model,
  messages: [{ role: "user", content: "请只回答一个算式结果：2+2=" }],
  temperature: 0,
})) {
  events.push(event)
  if (event.type === "text_delta") text += event.text
}

console.log(
  JSON.stringify(
    {
      ok: text.trim().length > 0,
      model: config.model,
      eventTypes: events.map((event) => event.type),
      error: events.find((event) => event.type === "error"),
      text: text.trim().slice(0, 120),
    },
    null,
    2,
  ),
)
