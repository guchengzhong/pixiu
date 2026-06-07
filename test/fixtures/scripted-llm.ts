import type { LLMClient, LLMStreamEvent, LLMStreamInput } from "../../src/llm/types"

export type ScriptedLLMStep =
  | LLMStreamEvent[]
  | ((input: LLMStreamInput, index: number) => LLMStreamEvent[] | Promise<LLMStreamEvent[]>)

export class ScriptedLLMClient implements LLMClient {
  #index = 0

  constructor(private readonly steps: ScriptedLLMStep[]) {}

  async *stream(input: LLMStreamInput): AsyncIterable<LLMStreamEvent> {
    const step = this.steps[Math.min(this.#index, this.steps.length - 1)]
    this.#index += 1
    const events = typeof step === "function" ? await step(input, this.#index - 1) : step
    for (const event of events ?? []) yield event
  }
}
