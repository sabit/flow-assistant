export type JsonPatchOperation = {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
};

export type WorkflowNode = {
  type: string;
  group?: string;
  binding?: string;
  semanticType?: string;
  component?: string;
  next?: string;
  transitions?: Array<{ to: string; when?: string; default?: true }>;
  presentation?: { title?: LocalizedText; subtitle?: LocalizedText };
  input?: Record<string, unknown>;
  validation?: unknown[];
  [key: string]: unknown;
};

export type LocalizedText = { en?: string; bn?: string };

export type WorkflowDocument = {
  version: 2;
  description?: string;
  start: string;
  nodes: Record<string, WorkflowNode>;
  groups?: Record<string, { label: LocalizedText; description?: LocalizedText; sequence?: number }>;
  contextSchema?: Record<
    string,
    { type: string; semanticType?: string; sensitive?: boolean; persist?: boolean }
  >;
  [key: string]: unknown;
};

export type WorkflowIssue = {
  severity: "error" | "warning";
  nodeId?: string;
  path?: string;
  message: string;
};

export type WorkflowRevision = {
  id: string;
  workflowId: string;
  parentRevisionId?: string;
  createdAt: string;
  source: "new" | "import" | "ai" | "restore";
  summary?: string;
  workflow: WorkflowDocument;
  patch?: JsonPatchOperation[];
  validation?: {
    status: "valid" | "invalid";
    issues: WorkflowIssue[];
  };
};

export type WorkflowRecord = {
  id: string;
  name: string;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowSelection =
  | { type: "node"; nodeId: string }
  | { type: "group"; groupId: string }
  | { type: "workflow" };

export type WorkflowAttachment = {
  type: "workflow_node" | "workflow_group" | "workflow";
  revisionId: string;
  nodeId?: string;
  groupId?: string;
};

export type PatchProposal = {
  summary: string;
  baseRevisionId: string;
  patch: JsonPatchOperation[];
  workflow: WorkflowDocument;
  issues: WorkflowIssue[];
  affectedNodeIds: string[];
};
