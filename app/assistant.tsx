"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKChat, useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { isToolUIPart } from "ai";
import { useEffect, useRef } from "react";
import { WorkflowWorkbench } from "./workbench";

const RetryContinuation = () => {
  const chat = useAISDKChat();
  const submittedToolCalls = useRef(new Set<string>());

  useEffect(() => {
    if (!chat || chat.status !== "ready") return;
    const lastMessage = chat.messages.at(-1);
    if (lastMessage?.role !== "assistant") return;
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
    if (!retryPart || submittedToolCalls.current.has(retryPart.toolCallId)) return;

    submittedToolCalls.current.add(retryPart.toolCallId);
    void chat.sendMessage().catch((error: unknown) => {
      submittedToolCalls.current.delete(retryPart.toolCallId);
      console.error("[chat] automatic correction request failed", error);
    });
  }, [chat, chat?.messages, chat?.status]);

  return null;
};

export const Assistant = () => {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: "/api/chat",
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RetryContinuation />
      <WorkflowWorkbench />
    </AssistantRuntimeProvider>
  );
};
