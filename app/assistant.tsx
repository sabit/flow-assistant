"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKChat, useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { isToolUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRequestMode } from "@/lib/workflow/request-mode";
import { WorkflowWorkbench } from "./workbench";

type RetryOutput = {
  retryRequired?: boolean;
};

const hasRetryOutput = (output: unknown): output is RetryOutput =>
  typeof output === "object" && output !== null && "retryRequired" in output;

const getRetryPart = (messages: UIMessage[]) => {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant") return undefined;
  const lastStepStart = lastMessage.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  const part = lastMessage.parts
    .slice(lastStepStart + 1)
    .filter(isToolUIPart)
    .find((part) => part.state === "output-available" && hasRetryOutput(part.output));
  return part && hasRetryOutput(part.output)
    ? { toolCallId: part.toolCallId, output: part.output }
    : undefined;
};

const getLatestUserMessageId = (messages: UIMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.id;
  }
  return undefined;
};

const RetryContinuation = () => {
  const chat = useAISDKChat();
  const retryState = useRef<{
    requestId?: string;
    toolCallCount: number;
    seenToolCallIds: Set<string>;
    submittedToolCallIds: Set<string>;
    pausedToolCallId?: string;
  }>({ toolCallCount: 0, seenToolCallIds: new Set(), submittedToolCallIds: new Set() });
  const [isResuming, setIsResuming] = useState(false);
  const [pausedToolCallId, setPausedToolCallId] = useState<string>();

  useEffect(() => {
    if (!chat) return;
    const requestId = getLatestUserMessageId(chat.messages);
    if (retryState.current.requestId !== requestId) {
      retryState.current = {
        requestId,
        toolCallCount: 0,
        seenToolCallIds: new Set(),
        submittedToolCallIds: new Set(),
      };
      setIsResuming(false);
      setPausedToolCallId(undefined);
    }
    const retryPart = getRetryPart(chat.messages);
    if (!retryPart || retryPart.output.retryRequired !== true) return;

    if (!retryState.current.seenToolCallIds.has(retryPart.toolCallId)) {
      retryState.current.seenToolCallIds.add(retryPart.toolCallId);
      retryState.current.toolCallCount += 1;
      if (retryState.current.toolCallCount % 10 === 0) {
        retryState.current.pausedToolCallId = retryPart.toolCallId;
        setIsResuming(false);
        setPausedToolCallId(retryPart.toolCallId);
        return;
      }
    }

    if (chat.status !== "ready" || retryState.current.pausedToolCallId === retryPart.toolCallId) {
      return;
    }

    if (retryState.current.submittedToolCallIds.has(retryPart.toolCallId)) return;
    retryState.current.submittedToolCallIds.add(retryPart.toolCallId);
    void chat.sendMessage().catch((error: unknown) => {
      retryState.current.submittedToolCallIds.delete(retryPart.toolCallId);
      console.error("[chat] automatic correction request failed", error);
    });
  }, [chat, chat?.messages, chat?.status]);

  const retryPart = chat ? getRetryPart(chat.messages) : undefined;
  const isPaused = pausedToolCallId === retryPart?.toolCallId;

  useEffect(() => {
    if (!isPaused) setIsResuming(false);
  }, [isPaused]);

  if (!chat || !retryPart || !isPaused) return null;
  const pauseCallId = retryPart.toolCallId;

  return (
    <div className="fixed inset-x-0 bottom-4 z-20 mx-auto w-fit rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 shadow-lg">
      <p>Workflow generation has paused after 10 retries.</p>
      <button
        type="button"
        className="mt-2 rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isResuming || chat.status !== "ready"}
        onClick={() => {
          setIsResuming(true);
          retryState.current.pausedToolCallId = undefined;
          setPausedToolCallId(undefined);
          retryState.current.submittedToolCallIds.add(pauseCallId);
          void chat.sendMessage().catch((error: unknown) => {
            retryState.current.pausedToolCallId = pauseCallId;
            setPausedToolCallId(pauseCallId);
            retryState.current.submittedToolCallIds.delete(pauseCallId);
            setIsResuming(false);
            console.error("[chat] retry resume request failed", error);
          });
        }}
      >
        {isResuming ? "Resuming…" : "Resume retries"}
      </button>
    </div>
  );
};

export const Assistant = () => {
  const [requestMode, setRequestMode] = useState<WorkflowRequestMode>("generate");
  const requestModeRef = useRef(requestMode);
  requestModeRef.current = requestMode;
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: (options) => ({
          body: {
            ...options.body,
            id: options.id,
            messages: options.messages,
            trigger: options.trigger,
            messageId: options.messageId,
            metadata: options.requestMetadata,
            requestMode: requestModeRef.current,
          },
        }),
      }),
    [],
  );
  const runtime = useChatRuntime({
    transport,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RetryContinuation />
      <WorkflowWorkbench requestMode={requestMode} onRequestModeChange={setRequestMode} />
    </AssistantRuntimeProvider>
  );
};
