import { createOpenAI } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import { type JSONSchema7, streamText, convertToModelMessages, type UIMessage } from "ai";

const getModelName = () => process.env.OLLAMA_MODEL ?? "qwen3:8b";

export async function GET() {
  return Response.json({ provider: "Ollama", model: getModelName() });
}

export async function POST(req: Request) {
  const {
    messages,
    system,
    tools,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
  } = await req.json();

  const ollamaBaseURL = `${(process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "")}/v1`;
  const ollama = createOpenAI({
    baseURL: ollamaBaseURL,
    apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
  });
  const model = getModelName();
  const modelMessages = await convertToModelMessages(messages);
  const toolEntries = Object.keys(tools ?? {});
  const toolSchemaChars = Object.fromEntries(
    Object.entries(tools ?? {}).map(([name, definition]) => [
      name,
      JSON.stringify(definition).length,
    ]),
  );
  console.debug("[chat] agent API call", {
    model,
    baseURL: ollamaBaseURL,
    messageCount: messages.length,
    convertedMessageCount: modelMessages.length,
    hasSystem: Boolean(system),
    systemChars: system?.length ?? 0,
    toolNames: toolEntries,
    toolCount: toolEntries.length,
    toolSchemaChars,
    totalToolSchemaChars: JSON.stringify(tools ?? {}).length,
    timestamp: new Date().toISOString(),
  });
  const result = streamText({
    model: ollama.chat(model),
    messages: modelMessages,
    system,
    tools: {
      ...frontendTools(tools ?? {}),
    },
    onChunk: ({ chunk }) => {
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        console.debug(`[chat] model response ${chunk.type}`, {
          text: chunk.text,
          id: chunk.id,
          timestamp: new Date().toISOString(),
        });
      }
    },
    onFinish: (result) => {
      console.debug("[chat] model response finish", {
        usage: result.usage,
        finishReason: result.finishReason,
        steps: result.steps.length,
        timestamp: new Date().toISOString(),
      });
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}
