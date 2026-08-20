import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "@/docs/kiosk-workflow.schema.json";
import { workflowAdapter } from "@/lib/workflow/adapter";
import type { WorkflowDocument, WorkflowIssue } from "@/lib/workflow/types";

const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export const validateWorkflow = (workflow: unknown): WorkflowIssue[] => {
  const issues: WorkflowIssue[] = [];
  if (!validateSchema(workflow)) {
    for (const error of validateSchema.errors ?? []) {
      issues.push({
        severity: "error",
        path: error.instancePath,
        message: `${error.instancePath || "workflow"} ${error.message ?? "is invalid"}`,
      });
    }
    return issues;
  }
  return [...issues, ...validateGraph(workflow as WorkflowDocument)];
};

export const validateGraph = (workflow: WorkflowDocument): WorkflowIssue[] => {
  const issues: WorkflowIssue[] = [];
  const nodes = workflow.nodes ?? {};
  if (!nodes[workflow.start]) {
    issues.push({
      severity: "error",
      path: "/start",
      message: `Start node "${workflow.start}" does not exist.`,
    });
  }
  const groups = workflow.groups ?? {};
  const edges = workflowAdapter.getEdges(workflow);
  for (const { id, node } of workflowAdapter.getNodes(workflow)) {
    if (node.group && !groups[node.group]) {
      issues.push({
        severity: "error",
        nodeId: id,
        path: `/nodes/${id}/group`,
        message: `References missing group "${node.group}".`,
      });
    }
  }
  for (const edge of edges) {
    if (!nodes[edge.to]) {
      issues.push({
        severity: "error",
        nodeId: edge.from,
        path: `/nodes/${edge.from}`,
        message: `References missing node "${edge.to}".`,
      });
    }
  }
  const visited = new Set<string>();
  const visit = (nodeId: string) => {
    if (visited.has(nodeId) || !nodes[nodeId]) return;
    visited.add(nodeId);
    for (const edge of edges.filter((item) => item.from === nodeId)) visit(edge.to);
  };
  visit(workflow.start);
  for (const nodeId of Object.keys(nodes)) {
    if (!visited.has(nodeId)) {
      issues.push({
        severity: "warning",
        nodeId,
        path: `/nodes/${nodeId}`,
        message: "Node is unreachable from start.",
      });
    }
  }
  if (!Object.values(nodes).some((node) => node.type === "result")) {
    issues.push({
      severity: "warning",
      path: "/nodes",
      message: "Workflow has no terminal result node.",
    });
  }
  return issues;
};
