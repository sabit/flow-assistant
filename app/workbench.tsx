"use client";

import mermaid from "mermaid";
import { applyPatch } from "fast-json-patch";
import {
  useAssistantContext,
  useAssistantInstructions,
  useAssistantTool,
  useAuiState,
} from "@assistant-ui/react";
import { z } from "zod";
import type { JSONSchema7 } from "ai";
import {
  Check,
  Copy,
  FileJson,
  History,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import workflowSchema from "@/docs/kiosk-workflow.schema.json";
import sampleWorkflow from "@/docs/minimal-valid-workflow.json";
import { Thread } from "@/components/assistant-ui/thread";
import { WorkflowJsonViewer } from "@/components/workflow-json-viewer";
import { workflowAdapter } from "@/lib/workflow/adapter";
import { workflowToMermaid } from "@/lib/workflow/mermaid";
import type { WorkflowRequestMode } from "@/lib/workflow/request-mode";
import {
  formatIssueWithHint,
  withSchemaHints,
  type HintedWorkflowIssue,
} from "@/lib/workflow/schema-hints";
import { workflowDb } from "@/lib/workflow/store";
import type {
  JsonPatchOperation,
  PatchProposal,
  WorkflowAttachment,
  WorkflowDocument,
  WorkflowIssue,
  WorkflowRecord,
  WorkflowRevision,
  WorkflowSelection,
} from "@/lib/workflow/types";
import { validateWorkflow } from "@/lib/workflow/validation";

const initialWorkflow = sampleWorkflow as WorkflowDocument;
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const assistantInstructions = `You are the workflow authoring assistant. Workflow documents are immutable browser-side revisions; you never mutate them directly.
For a request to generate a fresh workflow from business requirements, call generate_workflow with the complete workflow document. Its input schema is the complete kiosk workflow JSON Schema. If the tool returns status "invalid" with retryRequired true, silently correct the complete document from the structured validation errors and call generate_workflow again. Do not respond between attempts and do not ask to build one node at a time.
Do not emit optional properties merely because they exist in the schema. If an optional property is not required to represent the user's requirement, omit it. Never emit placeholder values such as {}, [], false, null, or empty strings just to populate optional properties.
For a requested modification to an existing workflow, inspect the provided revision-aware context and call propose_workflow_patch exactly once with an RFC 6902 JSON Patch and the exact baseRevisionId. Do not call either tool when the request is only explanatory. Use narrow patches for edits, preserve schema validity, and describe changes concisely. Valid changes are saved automatically as immutable revisions.`;

const nodeShapeReference = {
  input: "type, component, binding, and exactly one of next/transitions",
  selection: "type, binding, options, and exactly one of next/transitions",
  display: "type, content, next (variant is optional)",
  action: "type, operation, next",
  confirmation: "type, summary, next",
  submit: "type, operation, onSuccess, onFailure",
  result: "type, variant",
} as const;

const patchSchema = z.object({
  summary: z.string().min(1),
  baseRevisionId: z.string().min(1),
  patch: z
    .array(
      z.object({
        op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
        path: z.string().startsWith("/"),
        from: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1),
});

const issueSummary = (issues: WorkflowIssue[]) => {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return errors
    ? `${errors} error${errors === 1 ? "" : "s"}`
    : warnings
      ? `${warnings} warning${warnings === 1 ? "" : "s"}`
      : "Valid";
};

const selectionToAttachment = (
  selection: WorkflowSelection,
  revisionId: string,
): WorkflowAttachment =>
  selection.type === "node"
    ? { type: "workflow_node", revisionId, nodeId: selection.nodeId }
    : selection.type === "group"
      ? { type: "workflow_group", revisionId, groupId: selection.groupId }
      : { type: "workflow", revisionId };

const attachmentLabel = (
  attachment: WorkflowAttachment,
  revision: WorkflowRevision | undefined,
) => {
  if (!revision) return "Unavailable workflow context";
  if (attachment.type === "workflow") return "Whole workflow";
  if (attachment.type === "workflow_group") {
    return `Group · ${revision.workflow.groups?.[attachment.groupId ?? ""]?.label.en ?? attachment.groupId}`;
  }
  const node = revision.workflow.nodes[attachment.nodeId ?? ""];
  return `Node · ${node ? (node.presentation?.title?.en ?? node.binding ?? attachment.nodeId) : attachment.nodeId}`;
};

export function WorkflowWorkbench({
  requestMode,
  onRequestModeChange,
}: {
  requestMode: WorkflowRequestMode;
  onRequestModeChange: (mode: WorkflowRequestMode) => void;
}) {
  const [workflow, setWorkflow] = useState<WorkflowDocument>(initialWorkflow);
  const [workflowRecord, setWorkflowRecord] = useState<WorkflowRecord>();
  const [currentRevision, setCurrentRevision] = useState<WorkflowRevision>();
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([]);
  const [selection, setSelection] = useState<WorkflowSelection>();
  const [attachment, setAttachment] = useState<WorkflowAttachment>();
  const [proposal, setProposal] = useState<PatchProposal>();
  const [showAssistant, setShowAssistant] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [rawRevision, setRawRevision] = useState<WorkflowRevision>();
  const [pasteValue, setPasteValue] = useState("");
  const [notice, setNotice] = useState<string>();
  const [hydrated, setHydrated] = useState(false);
  const [modelInfo, setModelInfo] = useState<{ provider: string; model: string }>();
  const assistantIsRunning = useAuiState((state) => state.thread.isRunning);
  const issues = useMemo(() => validateWorkflow(workflow), [workflow]);

  const activate = useCallback(
    (record: WorkflowRecord, revision: WorkflowRevision, history: WorkflowRevision[]) => {
      setWorkflowRecord(record);
      setCurrentRevision(revision);
      setRevisions(history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setWorkflow(structuredClone(revision.workflow));
      setSelection(undefined);
      setAttachment(undefined);
      setProposal(undefined);
    },
    [],
  );

  const createWorkflow = useCallback(
    async (document: WorkflowDocument, source: "new" | "import") => {
      const createdAt = now();
      const workflowId = newId();
      const revision: WorkflowRevision = {
        id: newId(),
        workflowId,
        createdAt,
        source,
        summary: source === "import" ? "Imported workflow" : "New workflow",
        workflow: structuredClone(document),
      };
      const record: WorkflowRecord = {
        id: workflowId,
        name: document.description || "Untitled workflow",
        currentRevisionId: revision.id,
        createdAt,
        updatedAt: createdAt,
      };
      await workflowDb.transaction("rw", workflowDb.workflows, workflowDb.revisions, async () => {
        await workflowDb.workflows.add(record);
        await workflowDb.revisions.add(revision);
      });
      activate(record, revision, [revision]);
    },
    [activate],
  );

  const createRevision = useCallback(
    async (
      document: WorkflowDocument,
      source: WorkflowRevision["source"],
      summary?: string,
      patch?: JsonPatchOperation[],
    ) => {
      if (!workflowRecord || !currentRevision) return;
      const revision: WorkflowRevision = {
        id: newId(),
        workflowId: workflowRecord.id,
        parentRevisionId: currentRevision.id,
        createdAt: now(),
        source,
        summary,
        patch,
        workflow: structuredClone(document),
      };
      const record = {
        ...workflowRecord,
        currentRevisionId: revision.id,
        updatedAt: revision.createdAt,
      };
      await workflowDb.transaction("rw", workflowDb.workflows, workflowDb.revisions, async () => {
        await workflowDb.workflows.put(record);
        await workflowDb.revisions.add(revision);
      });
      activate(record, revision, [...revisions, revision]);
      return revision;
    },
    [activate, currentRevision, revisions, workflowRecord],
  );

  const saveInvalidGenerationAttempt = useCallback(
    async (document: WorkflowDocument, attemptIssues: WorkflowIssue[]) => {
      if (!workflowRecord || !currentRevision) return;
      const revision: WorkflowRevision = {
        id: newId(),
        workflowId: workflowRecord.id,
        parentRevisionId: currentRevision.id,
        createdAt: now(),
        source: "ai",
        summary: "Invalid AI generation attempt",
        workflow: structuredClone(document),
        validation: {
          status: "invalid",
          issues: attemptIssues,
        },
      };
      const record = {
        ...workflowRecord,
        currentRevisionId: revision.id,
        updatedAt: revision.createdAt,
      };
      await workflowDb.transaction("rw", workflowDb.workflows, workflowDb.revisions, async () => {
        await workflowDb.workflows.put(record);
        await workflowDb.revisions.add(revision);
      });
      activate(record, revision, [...revisions, revision]);
      return revision;
    },
    [activate, currentRevision, revisions, workflowRecord],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const records = await workflowDb.workflows.toArray();
      if (cancelled) return;
      if (!records.length) {
        await createWorkflow(initialWorkflow, "import");
      } else {
        const record = records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
        const history = await workflowDb.revisions.where("workflowId").equals(record.id).toArray();
        const revision = history.find((item) => item.id === record.currentRevisionId);
        if (revision) activate(record, revision, history);
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [activate, createWorkflow]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/chat", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Model info is unavailable");
        return response.json() as Promise<{ provider: string; model: string }>;
      })
      .then(setModelInfo)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("[chat] could not load model info", error);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!attachment && requestMode === "modify") {
      onRequestModeChange("explain");
    }
  }, [attachment, onRequestModeChange, requestMode]);

  useAssistantInstructions(assistantInstructions);
  useAssistantContext({
    getContext: () => {
      if (!attachment)
        return "No workflow element is attached. Fresh workflow generation is available from the user's business requirements; an existing element must be attached before proposing an edit.";
      const revision = revisions.find((item) => item.id === attachment.revisionId);
      if (!revision) return "The attached workflow revision is unavailable.";
      const attachedSelection: WorkflowSelection =
        attachment.type === "workflow_node"
          ? { type: "node", nodeId: attachment.nodeId! }
          : attachment.type === "workflow_group"
            ? { type: "group", groupId: attachment.groupId! }
            : { type: "workflow" };
      const context =
        attachment.type === "workflow"
          ? revision.workflow
          : workflowAdapter.buildSelectionContext(revision.workflow, attachedSelection);
      return `Workflow context (immutable):\n${JSON.stringify({ workflowId: revision.workflowId, revisionId: revision.id, selection: context }, null, 2)}`;
    },
  });

  useAssistantTool<
    WorkflowDocument,
    {
      status: string;
      validation: string;
      errors: HintedWorkflowIssue[];
      retryRequired: boolean;
      correctionInstructions?: string;
      nodeShapeReference?: typeof nodeShapeReference;
      savedRevisionId?: string;
    }
  >({
    toolName: "generate_workflow",
    description:
      "Generate a complete new kiosk workflow from the user's business requirements. The arguments must be the full workflow document and conform to the supplied JSON Schema. A valid workflow is saved automatically as a new immutable revision.",
    parameters: workflowSchema as unknown as JSONSchema7,
    execute: async (generatedWorkflow) => {
      const issues = validateWorkflow(generatedWorkflow);
      const errors = withSchemaHints(issues.filter((issue) => issue.severity === "error"));
      const hasErrors = errors.length > 0;
      const retryRequired = hasErrors;
      let savedRevisionId: string | undefined;
      if (!hasErrors) {
        const revision = await createRevision(
          generatedWorkflow,
          "ai",
          "Valid AI-generated workflow",
        );
        savedRevisionId = revision?.id;
        setNotice("Generated workflow saved as a new revision.");
      } else {
        const revision = await saveInvalidGenerationAttempt(generatedWorkflow, issues);
        savedRevisionId = revision?.id;
      }
      return {
        status: hasErrors ? "invalid" : "applied",
        validation: issueSummary(issues),
        errors,
        retryRequired,
        savedRevisionId,
        ...(hasErrors
          ? {
              correctionInstructions:
                "Correct every structured validation error in the same complete document, applying each error's fix hint. The next turn is forced to call generate_workflow; do not emit conversational text.",
              nodeShapeReference,
            }
          : {}),
      };
    },
    render: ({ result, status, argsText }) => {
      if (status.type === "running") {
        return (
          <div className="my-3 rounded-xl border border-cyan-200 bg-cyan-50 p-3 text-xs text-cyan-900">
            Generating and validating workflow…
          </div>
        );
      }
      if (status.type === "complete" && result?.status === "applied") {
        return (
          <WorkflowToolSuccess
            title="Workflow generated"
            message="The validated workflow was saved as a new revision."
            revisionId={result.savedRevisionId}
          />
        );
      }
      return (
        <WorkflowToolError
          title={result?.retryRequired ? "Correcting workflow" : "Workflow generation failed"}
          messages={result?.errors.map(formatIssueWithHint)}
          fallback={
            status.type === "incomplete"
              ? `The model produced an incomplete tool call (${status.reason}).`
              : "The generated JSON did not pass workflow validation."
          }
          details={argsText}
          savedRevisionId={result?.savedRevisionId}
          retryMessage={result?.retryRequired ? "Retrying automatically…" : undefined}
        />
      );
    },
  });

  useAssistantTool({
    toolName: "propose_workflow_patch",
    description:
      "Propose an RFC 6902 patch to the attached immutable workflow revision. This never mutates the workflow.",
    parameters: patchSchema,
    execute: async (args) => {
      if (!currentRevision)
        return { status: "unavailable", message: "No workflow revision is loaded." };
      if (args.baseRevisionId !== currentRevision.id) {
        return {
          status: "stale",
          message: `Current revision is ${currentRevision.id}; proposal targets ${args.baseRevisionId}.`,
        };
      }
      try {
        const result = applyPatch(
          structuredClone(currentRevision.workflow),
          args.patch as Parameters<typeof applyPatch>[1],
          true,
          true,
        );
        const nextWorkflow = result.newDocument as WorkflowDocument;
        const nextIssues = validateWorkflow(nextWorkflow);
        const affectedNodeIds = [
          ...new Set(
            args.patch
              .map((operation) => operation.path.match(/^\/nodes\/([^/]+)/)?.[1])
              .filter(Boolean) as string[],
          ),
        ];
        const errors = nextIssues.filter((issue) => issue.severity === "error");
        if (!errors.length) {
          await createRevision(
            nextWorkflow,
            "ai",
            args.summary,
            args.patch as JsonPatchOperation[],
          );
          setNotice("Workflow change saved as a new revision.");
        }
        return {
          status: errors.length ? "invalid" : "applied",
          validation: issueSummary(nextIssues),
          affectedNodeIds,
          errors: withSchemaHints(errors),
        };
      } catch (error) {
        return {
          status: "invalid",
          message: error instanceof Error ? error.message : "Patch could not be applied.",
        };
      }
    },
    render: ({ result, status, argsText }) => {
      const toolResult = result as
        | { status?: string; message?: string; errors?: HintedWorkflowIssue[] }
        | undefined;
      if (status.type === "running") {
        return (
          <div className="my-3 rounded-xl border border-cyan-200 bg-cyan-50 p-3 text-xs text-cyan-900">
            Preparing and validating workflow changes…
          </div>
        );
      }
      if (status.type === "complete" && toolResult?.status === "applied") {
        return (
          <WorkflowToolSuccess
            title="Workflow updated"
            message="The validated change was saved as a new revision."
          />
        );
      }
      return (
        <WorkflowToolError
          title="Workflow edit failed"
          messages={toolResult?.errors?.map(formatIssueWithHint)}
          fallback={
            toolResult?.message ??
            (status.type === "incomplete"
              ? `The model produced an incomplete tool call (${status.reason}).`
              : "The workflow patch could not be applied.")
          }
          details={argsText}
        />
      );
    },
  });

  const importWorkflow = async () => {
    try {
      const document = JSON.parse(pasteValue) as WorkflowDocument;
      const importIssues = validateWorkflow(document);
      const errors = importIssues.filter((issue) => issue.severity === "error");
      if (errors.length) {
        setNotice(`Import failed: ${errors[0]?.message}`);
        return;
      }
      await createWorkflow(document, "import");
      setPasteValue("");
      setShowPaste(false);
      setNotice("Workflow imported as a new immutable revision.");
    } catch {
      setNotice("Import failed: clipboard content is not valid JSON.");
    }
  };

  const copyWorkflow = async () => {
    await navigator.clipboard.writeText(JSON.stringify(workflow, null, 2));
    setNotice("Current workflow JSON copied to the clipboard.");
  };

  const newWorkflow = async () => {
    await createWorkflow(initialWorkflow, "new");
    setNotice("Created a fresh workflow from the supplied starter.");
  };

  const restore = async (revision: WorkflowRevision) => {
    await createRevision(
      revision.workflow,
      "restore",
      `Restored revision ${revision.id.slice(0, 8)}`,
    );
    setShowHistory(false);
  };

  const attachedRevision = attachment
    ? revisions.find((item) => item.id === attachment.revisionId)
    : undefined;
  const selectedNode = selection?.type === "node" ? workflow.nodes[selection.nodeId] : undefined;
  const requestModes: Array<{
    mode: WorkflowRequestMode;
    label: string;
    disabled?: boolean;
  }> = [
    { mode: "generate", label: "Generate" },
    { mode: "modify", label: "Edit", disabled: !attachment },
    { mode: "explain", label: "Ask" },
  ];

  return (
    <main className="flex h-dvh min-w-0 flex-col bg-slate-50 text-slate-950">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-500" />
            <h1 className="text-sm font-semibold tracking-wide">Flow Assistant</h1>
          </div>
          <p className="truncate text-xs text-slate-500">
            {workflowRecord?.name ?? "Loading workflow"} ·{" "}
            {currentRevision ? `rev ${currentRevision.id.slice(0, 8)}` : "local draft"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HeaderButton onClick={() => void newWorkflow()} icon={<Plus size={15} />} label="New" />
          <HeaderButton
            onClick={() => setShowPaste(true)}
            icon={<Upload size={15} />}
            label="Paste"
          />
          <HeaderButton
            onClick={() => void copyWorkflow()}
            icon={<Copy size={15} />}
            label="Copy"
          />
          <HeaderButton
            onClick={() => setShowHistory(true)}
            icon={<History size={15} />}
            label="History"
          />
          <button
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
            onClick={() => setShowAssistant((value) => !value)}
            aria-label="Toggle assistant panel"
          >
            {showAssistant ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </div>
      </header>

      {notice && (
        <div className="flex shrink-0 items-center justify-between border-b border-cyan-100 bg-cyan-50 px-4 py-2 text-xs text-cyan-900">
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:px-6">
            <div>
              <h2 className="text-sm font-semibold">
                {workflow.description || "Untitled workflow"}
              </h2>
              <p className="text-xs text-slate-500">
                Read-only graph · select a node to inspect it
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ValidationBadge issues={issues} />
              <button
                type="button"
                disabled={!currentRevision}
                onClick={() => currentRevision && setRawRevision(currentRevision)}
                className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <FileJson size={14} /> View Raw
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
            <MermaidCanvas
              workflow={workflow}
              selectedNodeId={selection?.type === "node" ? selection.nodeId : undefined}
              onSelect={(nodeId) => setSelection({ type: "node", nodeId })}
            />
          </div>
          {(selection || proposal) && (
            <aside className="max-h-[38%] shrink-0 overflow-auto border-t border-slate-200 bg-white px-4 py-4 md:px-6">
              {proposal ? (
                <ProposalDetail
                  proposal={proposal}
                  currentRevision={currentRevision}
                  onApply={() =>
                    void createRevision(proposal.workflow, "ai", proposal.summary, proposal.patch)
                  }
                  onReject={() => setProposal(undefined)}
                />
              ) : selection?.type === "node" && selectedNode ? (
                <NodeInspector
                  nodeId={selection.nodeId}
                  node={selectedNode}
                  workflow={workflow}
                  onAttach={() => {
                    if (!currentRevision) return;
                    setAttachment(selectionToAttachment(selection, currentRevision.id));
                    onRequestModeChange("modify");
                  }}
                />
              ) : selection?.type === "group" ? (
                <GroupInspector
                  groupId={selection.groupId}
                  workflow={workflow}
                  onAttach={() => {
                    if (!currentRevision) return;
                    setAttachment(selectionToAttachment(selection, currentRevision.id));
                    onRequestModeChange("modify");
                  }}
                />
              ) : null}
            </aside>
          )}
        </section>

        {showAssistant && (
          <aside className="flex w-[min(100%,28rem)] shrink-0 flex-col border-l border-slate-200 bg-white">
            <div className="flex min-h-14 items-center justify-between gap-3 border-b border-slate-200 px-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Workflow assistant</h2>
                <p className="text-xs text-slate-500">Changes are saved as undoable revisions</p>
              </div>
              <span
                className="max-w-44 shrink-0 truncate rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-[10px] text-slate-600"
                title={
                  modelInfo
                    ? `${modelInfo.provider} model: ${modelInfo.model}`
                    : "Loading current model"
                }
              >
                {modelInfo ? `${modelInfo.provider} · ${modelInfo.model}` : "Model · …"}
              </span>
            </div>
            {attachment && (
              <div className="mx-3 mt-3 flex items-center justify-between gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-950">
                <span className="truncate">
                  <span className="font-semibold">Attached · </span>
                  {attachmentLabel(attachment, attachedRevision)}{" "}
                  <span className="text-cyan-700">({attachment.revisionId.slice(0, 8)})</span>
                </span>
                <button
                  onClick={() => setAttachment(undefined)}
                  aria-label="Remove workflow context"
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="mx-3 mt-3 flex rounded-lg border border-slate-200 bg-slate-50 p-1">
              {requestModes.map(({ mode, label, disabled }) => (
                <button
                  key={mode}
                  type="button"
                  disabled={disabled}
                  aria-pressed={requestMode === mode}
                  onClick={() => onRequestModeChange(mode)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    requestMode === mode
                      ? "bg-white text-slate-950 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {assistantIsRunning && (
              <div
                role="status"
                aria-live="polite"
                className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-950"
              >
                <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-cyan-500" />
                <span>
                  {requestMode === "generate"
                    ? "Generating workflow and preparing the tool call…"
                    : requestMode === "modify"
                      ? "Preparing workflow changes and the tool call…"
                      : "Preparing an answer…"}
                </span>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <Thread components={{ Welcome: WorkflowWelcome }} />
            </div>
          </aside>
        )}
      </div>

      {showPaste && (
        <PasteDialog
          value={pasteValue}
          onChange={setPasteValue}
          onClose={() => setShowPaste(false)}
          onImport={() => void importWorkflow()}
        />
      )}
      {showHistory && (
        <HistoryDialog
          revisions={revisions}
          currentRevisionId={currentRevision?.id}
          onClose={() => setShowHistory(false)}
          onRestore={(revision) => void restore(revision)}
          onViewRaw={(revision) => setRawRevision(revision)}
        />
      )}
      {rawRevision && (
        <RawWorkflowDialog revision={rawRevision} onClose={() => setRawRevision(undefined)} />
      )}
      {!hydrated && (
        <div className="pointer-events-none fixed inset-x-0 bottom-3 text-center text-xs text-slate-400">
          Opening local workflow history…
        </div>
      )}
    </main>
  );
}

function MermaidCanvas({
  workflow,
  selectedNodeId,
  onSelect,
}: {
  workflow: WorkflowDocument;
  selectedNodeId?: string;
  onSelect: (nodeId: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nodeMap = new Map(
      Object.keys(workflow.nodes).map((id) => [`node_${id.replace(/[^A-Za-z0-9_]/g, "_")}`, id]),
    );
    (window as Window & { workflowSelect?: (id: string) => void }).workflowSelect = (id) => {
      const nodeId = nodeMap.get(id);
      if (nodeId) onSelect(nodeId);
    };
    return () => {
      delete (window as Window & { workflowSelect?: (id: string) => void }).workflowSelect;
    };
  }, [onSelect, workflow.nodes]);
  useEffect(() => {
    let active = true;
    const render = async () => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        flowchart: { htmlLabels: true, curve: "basis" },
      });
      const result = await mermaid.render(
        `workflow-${Math.random().toString(36).slice(2)}`,
        workflowToMermaid(workflow, selectedNodeId),
      );
      if (!active || !host.current) return;
      host.current.innerHTML = result.svg;
      result.bindFunctions?.(host.current);
    };
    void render().catch(() => {
      if (host.current) host.current.textContent = "Workflow graph could not be rendered.";
    });
    return () => {
      active = false;
    };
  }, [selectedNodeId, workflow]);
  return (
    <div
      ref={host}
      className="workflow-canvas flex min-h-full min-w-max items-center justify-center rounded-xl border border-slate-200 bg-[radial-gradient(#d8e3ed_1px,transparent_1px)] bg-size-[18px_18px] p-8 [&_svg]:max-w-none"
    />
  );
}

function WorkflowWelcome() {
  return (
    <div className="mb-6 flex flex-col items-center px-6 text-center">
      <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-cyan-100 text-cyan-800">
        ✦
      </div>
      <h3 className="text-lg font-semibold">Shape the workflow</h3>
      <p className="mt-1 text-sm text-slate-500">
        Select a node, attach it, then ask for a focused change.
      </p>
    </div>
  );
}

function HeaderButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="hidden items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 sm:flex"
    >
      {icon}
      {label}
    </button>
  );
}

function ValidationBadge({ issues }: { issues: WorkflowIssue[] }) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${errors ? "bg-rose-100 text-rose-700" : warnings ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}
    >
      {errors ? `${errors} errors` : warnings ? `${warnings} warnings` : "Validated"}
    </span>
  );
}

function NodeInspector({
  nodeId,
  node,
  workflow,
  onAttach,
}: {
  nodeId: string;
  node: WorkflowDocument["nodes"][string];
  workflow: WorkflowDocument;
  onAttach: () => void;
}) {
  const edges = workflowAdapter.getEdges(workflow);
  const incoming = edges.filter((edge) => edge.to === nodeId);
  const outgoing = edges.filter((edge) => edge.from === nodeId);
  const contextField = node.binding ? workflow.contextSchema?.[node.binding] : undefined;
  return (
    <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-[1fr_auto]">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">{node.type}</span>
          <h3 className="font-semibold">
            {node.presentation?.title?.en ?? node.binding ?? nodeId}
          </h3>
        </div>
        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Info label="Node ID" value={nodeId} />
          <Info label="Binding" value={node.binding} />
          <Info label="Semantic type" value={node.semanticType ?? contextField?.semanticType} />
          <Info label="Group" value={node.group} />
          <Info label="Incoming" value={incoming.map((edge) => edge.from).join(", ") || "—"} />
          <Info label="Outgoing" value={outgoing.map((edge) => edge.to).join(", ") || "—"} />
        </div>
      </div>
      <button
        onClick={onAttach}
        className="h-fit rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700"
      >
        Add to chat
      </button>
    </div>
  );
}

function GroupInspector({
  groupId,
  workflow,
  onAttach,
}: {
  groupId: string;
  workflow: WorkflowDocument;
  onAttach: () => void;
}) {
  const group = workflow.groups?.[groupId];
  const members = workflowAdapter.getNodes(workflow).filter((node) => node.groupId === groupId);
  return (
    <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
      <div>
        <h3 className="font-semibold">{group?.label.en ?? groupId}</h3>
        <p className="mt-1 text-sm text-slate-500">
          {members.length} nodes · {members.map((item) => item.label).join(", ")}
        </p>
      </div>
      <button
        onClick={onAttach}
        className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white"
      >
        Add group to chat
      </button>
    </div>
  );
}

function Info({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span className="text-xs text-slate-500">{label}</span>
      <p className="truncate font-mono text-xs text-slate-800">{value || "—"}</p>
    </div>
  );
}

function WorkflowToolError({
  title,
  messages,
  fallback,
  details,
  savedRevisionId,
  retryMessage,
}: {
  title: string;
  messages?: string[];
  fallback: string;
  details?: string;
  savedRevisionId?: string;
  retryMessage?: string;
}) {
  const reasons = messages?.length ? messages : [fallback];
  return (
    <div className="my-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-950">
      <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">{title}</p>
      {savedRevisionId && (
        <p className="mt-1 text-xs text-rose-800">
          Saved as current revision <span className="font-mono">{savedRevisionId.slice(0, 8)}</span>
        </p>
      )}
      {retryMessage && <p className="mt-1 text-xs font-medium text-rose-800">{retryMessage}</p>}
      <div className={`mt-2 grid gap-3 ${details ? "md:grid-cols-2" : ""}`}>
        <div className="min-w-0 rounded-md bg-white/70 p-2">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
            Schema validation
          </p>
          <ul className="max-h-72 list-disc space-y-1 overflow-auto pl-4 text-xs">
            {reasons.map((reason, index) => (
              <li key={`${index}-${reason}`}>{reason}</li>
            ))}
          </ul>
        </div>
        {details && (
          <div className="min-w-0 rounded-md bg-slate-950 p-2">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Raw generated JSON
            </p>
            <HighlightedJson source={details} />
          </div>
        )}
      </div>
    </div>
  );
}

function WorkflowToolSuccess({
  title,
  message,
  revisionId,
}: {
  title: string;
  message: string;
  revisionId?: string;
}) {
  return (
    <div className="my-3 flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
      <Check className="mt-0.5 shrink-0 text-emerald-700" size={16} />
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-emerald-800">{message}</p>
        {revisionId && (
          <p className="mt-1 font-mono text-[10px] text-emerald-700">
            Revision {revisionId.slice(0, 8)}
          </p>
        )}
      </div>
    </div>
  );
}

function HighlightedJson({ source }: { source: string }) {
  const tokens = source.split(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b)/g,
  );
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-200">
      {tokens.map((token, index) => {
        const trimmed = token.trim();
        const className = trimmed.endsWith(":")
          ? "text-cyan-300"
          : trimmed.startsWith('"')
            ? "text-emerald-300"
            : /^(true|false|null)$/.test(trimmed)
              ? "text-violet-300"
              : /^-?\d/.test(trimmed)
                ? "text-amber-300"
                : undefined;
        return (
          <span className={className} key={index}>
            {token}
          </span>
        );
      })}
    </pre>
  );
}

function ProposalDetail({
  proposal,
  currentRevision,
  onApply,
  onReject,
}: {
  proposal: PatchProposal;
  currentRevision?: WorkflowRevision;
  onApply: () => void;
  onReject: () => void;
}) {
  const errors = proposal.issues.filter((issue) => issue.severity === "error");
  const stale = currentRevision?.id !== proposal.baseRevisionId;
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-700">
            Pending proposal
          </p>
          <h3 className="font-semibold">{proposal.summary}</h3>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onReject}
            className="rounded-md border border-slate-200 px-3 py-2 text-xs"
          >
            Reject
          </button>
          <button
            disabled={Boolean(errors.length || stale)}
            onClick={onApply}
            className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            Apply revision
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-3 text-xs md:grid-cols-3">
        <Info label="Base revision" value={proposal.baseRevisionId.slice(0, 8)} />
        <Info
          label="Affected nodes"
          value={proposal.affectedNodeIds.join(", ") || "Workflow metadata"}
        />
        <Info label="Validation" value={stale ? "Stale proposal" : issueSummary(proposal.issues)} />
      </div>
      <details className="mt-3 rounded-lg bg-slate-50 p-3">
        <summary className="cursor-pointer text-xs font-medium">Raw RFC 6902 patch</summary>
        <pre className="mt-2 overflow-auto text-xs text-slate-600">
          {JSON.stringify(proposal.patch, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function PasteDialog({
  value,
  onChange,
  onClose,
  onImport,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onImport: () => void;
}) {
  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-slate-950/30 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Paste workflow JSON</h2>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Schema and graph validation run before this creates a workflow.
        </p>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste raw workflow JSON…"
          className="mt-4 h-72 w-full rounded-lg border border-slate-200 p-3 font-mono text-xs outline-none focus:border-cyan-500"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={onImport}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          >
            Validate & import
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryDialog({
  revisions,
  currentRevisionId,
  onClose,
  onRestore,
  onViewRaw,
}: {
  revisions: WorkflowRevision[];
  currentRevisionId?: string;
  onClose: () => void;
  onRestore: (revision: WorkflowRevision) => void;
  onViewRaw: (revision: WorkflowRevision) => void;
}) {
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-950/20">
      <aside className="h-full w-full max-w-md overflow-auto bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Revision history</h2>
            <p className="text-sm text-slate-500">Restoring creates a new revision.</p>
          </div>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="mt-5 space-y-3">
          {revisions.map((revision) => (
            <div
              key={revision.id}
              role="button"
              tabIndex={0}
              onClick={() => onViewRaw(revision)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onViewRaw(revision);
              }}
              className={`rounded-lg border p-3 ${revision.id === currentRevisionId ? "border-cyan-300 bg-cyan-50" : "border-slate-200"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{revision.summary ?? revision.source}</p>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    {revision.id.slice(0, 8)} · {new Date(revision.createdAt).toLocaleString()}
                  </p>
                </div>
                {revision.id === currentRevisionId ? (
                  <span className="flex items-center gap-1 text-xs text-cyan-800">
                    <Check size={13} />
                    {revision.validation?.status === "invalid" ? "Current · invalid" : "Current"}
                  </span>
                ) : (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onRestore(revision);
                    }}
                    className="rounded border border-slate-200 px-2 py-1 text-xs"
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function RawWorkflowDialog({
  revision,
  onClose,
}: {
  revision: WorkflowRevision;
  onClose: () => void;
}) {
  const revisionIssues = useMemo(() => validateWorkflow(revision.workflow), [revision.workflow]);
  const errors = revisionIssues.filter((issue) => issue.severity === "error").length;
  const warnings = revisionIssues.length - errors;
  const [copied, setCopied] = useState(false);
  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(revision.workflow, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/50 p-4">
      <section className="flex h-[min(52rem,92vh)] w-[min(76rem,96vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">Raw workflow JSON</h2>
            <p className="mt-0.5 font-mono text-xs text-slate-500">
              Revision {revision.id.slice(0, 8)} · {errors} errors · {warnings} warnings
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={copyJson}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
              aria-label={copied ? "Copied raw workflow JSON" : "Copy raw workflow JSON"}
            >
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
              aria-label="Close raw workflow"
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <WorkflowJsonViewer document={revision.workflow} issues={revisionIssues} />
        </div>
        <footer className="shrink-0 border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
          Schema errors are marked in red; warnings are marked in amber. Hover a marker for details.
        </footer>
      </section>
    </div>
  );
}
