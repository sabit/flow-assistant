import { createOpenAI } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import {
  getToolName,
  isToolUIPart,
  type JSONSchema7,
  streamText,
  convertToModelMessages,
  type UIMessage,
} from "ai";

const getModelName = () => process.env.OLLAMA_MODEL ?? "qwen3:8b";

export async function GET() {
  return Response.json({ provider: "Ollama", model: getModelName() });
}

const getRetryToolName = (messages: UIMessage[]) => {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant") return undefined;
  const lastStepStart = lastMessage.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  const retryPart = lastMessage.parts
    .slice(lastStepStart + 1)
    .filter(isToolUIPart)
    .find(
      (part) =>
        part.state === "output-available" &&
        typeof part.output === "object" &&
        part.output !== null &&
        "retryRequired" in part.output &&
        part.output.retryRequired === true,
    );
  return retryPart ? getToolName(retryPart) : undefined;
};

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
  const retryToolName = getRetryToolName(messages);
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
    retryToolName,
    toolSchemaChars,
    totalToolSchemaChars: JSON.stringify(tools ?? {}).length,
    timestamp: new Date().toISOString(),
  });
  const availableTools = frontendTools(tools ?? {});
  const forcedRetryTool =
    retryToolName && retryToolName in availableTools ? retryToolName : undefined;
  const initialGenerationTool =
    messages.length === 1 && "generate_workflow" in availableTools
      ? "generate_workflow"
      : undefined;
  const forcedTool = forcedRetryTool ?? initialGenerationTool;
  console.debug("[chat] tool choice", {
    choice: forcedTool ?? "auto",
    reason: forcedRetryTool
      ? "validation-retry"
      : initialGenerationTool
        ? "initial-generation"
        : "auto",
    timestamp: new Date().toISOString(),
  });
  const result = streamText({
    model: ollama.chat(model),
    messages: modelMessages,
    system,
    tools: availableTools,
    toolChoice: forcedTool ? { type: "tool" as const, toolName: forcedTool } : "auto",
    onChunk: ({ chunk }) => {
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        console.debug(`[chat] model response ${chunk.type}`, {
          text: chunk.text,
          id: chunk.id,
          timestamp: new Date().toISOString(),
        });
      } else if (chunk.type === "tool-input-start") {
        console.debug("[chat] model response tool-input-start", {
          toolName: chunk.toolName,
          id: chunk.id,
          timestamp: new Date().toISOString(),
        });
      } else if (chunk.type === "tool-input-end") {
        console.debug("[chat] model response tool-input-end", {
          id: chunk.id,
          timestamp: new Date().toISOString(),
        });
      } else if (chunk.type === "tool-call") {
        console.debug("[chat] model response tool-call", {
          toolName: chunk.toolName,
          id: chunk.toolCallId,
          invalid: chunk.invalid,
          error: chunk.error instanceof Error ? chunk.error.message : undefined,
          timestamp: new Date().toISOString(),
        });
      } else if (chunk.type === "error") {
        console.error("[chat] model response error", {
          error: chunk.error instanceof Error ? chunk.error.message : String(chunk.error),
          timestamp: new Date().toISOString(),
        });
      }
    },
    onFinish: (result) => {
      console.debug("[chat] model response finish", {
        usage: result.usage,
        finishReason: result.finishReason,
        steps: result.steps.length,
        toolCalls: result.steps.flatMap((step) =>
          step.toolCalls.map((toolCall) => ({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
          })),
        ),
        warnings: result.warnings,
        timestamp: new Date().toISOString(),
      });
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}
