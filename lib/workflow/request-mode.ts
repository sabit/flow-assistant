export const workflowRequestModes = ["generate", "modify", "explain"] as const;

export type WorkflowRequestMode = (typeof workflowRequestModes)[number];

export const isWorkflowRequestMode = (value: unknown): value is WorkflowRequestMode =>
  workflowRequestModes.includes(value as WorkflowRequestMode);

export const workflowToolForRequestMode: Record<Exclude<WorkflowRequestMode, "explain">, string> = {
  generate: "generate_workflow",
  modify: "propose_workflow_patch",
};
