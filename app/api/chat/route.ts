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
import {
  isWorkflowRequestMode,
  workflowToolForRequestMode,
  type WorkflowRequestMode,
} from "@/lib/workflow/request-mode";

const getModelName = () => process.env.OLLAMA_MODEL ?? "qwen3:8b";

const modeInstructions: Record<WorkflowRequestMode, string> = {
  generate:
    "Active request mode: generate. Call generate_workflow with a complete workflow document. Do not emit the workflow document as conversational text.",
  modify:
    "Active request mode: modify. Call propose_workflow_patch with the requested change. Do not emit the patch as conversational text.",
  explain:
    "Active request mode: explain. Answer conversationally. No workflow tool is available for this request.",
};

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
    requestMode: rawRequestMode,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
    requestMode?: unknown;
  } = await req.json();
  const requestMode: WorkflowRequestMode = isWorkflowRequestMode(rawRequestMode)
    ? rawRequestMode
    : "explain";

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
  const modeTool = requestMode === "explain" ? undefined : workflowToolForRequestMode[requestMode];
  const forcedTool = forcedRetryTool ?? modeTool;
  if (forcedTool && !(forcedTool in availableTools)) {
    return Response.json(
      { error: `Request mode ${requestMode} requires unavailable tool ${forcedTool}.` },
      { status: 400 },
    );
  }
  const selectedTools = forcedTool ? { [forcedTool]: availableTools[forcedTool]! } : {};
  const requestSystem = [system, modeInstructions[requestMode]].filter(Boolean).join("\n\n");
  console.debug("[chat] tool choice", {
    requestMode,
    choice: forcedTool ?? "none",
    activeTools: Object.keys(selectedTools),
    reason: forcedRetryTool
      ? "validation-retry"
      : modeTool
        ? `request-mode-${requestMode}`
        : "request-mode-explain",
    timestamp: new Date().toISOString(),
  });
  const result = streamText({
    model: ollama.chat(model),
    messages: modelMessages,
    system: requestSystem,
    tools: selectedTools,
    activeTools: Object.keys(selectedTools),
    toolChoice: forcedTool ? { type: "tool" as const, toolName: forcedTool } : "none",
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
