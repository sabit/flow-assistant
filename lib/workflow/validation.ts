import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ErrorObject } from "ajv";
import schema from "@/docs/kiosk-workflow.schema.json";
import { workflowAdapter } from "@/lib/workflow/adapter";
import type { WorkflowDocument, WorkflowIssue } from "@/lib/workflow/types";

const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const escapeJsonPointer = (segment: string) => segment.replaceAll("~", "~0").replaceAll("/", "~1");

const formatSchemaError = (error: ErrorObject): WorkflowIssue => {
  let path = error.instancePath;
  let message = error.message ?? "is invalid";

  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    path = `${path}/${escapeJsonPointer(property)}`;
    message = "is not allowed";
  } else if (error.keyword === "required") {
    const property = String(error.params.missingProperty);
    path = `${path}/${escapeJsonPointer(property)}`;
    message = "is required";
  } else if (error.keyword === "const") {
    message = `must equal ${JSON.stringify(error.params.allowedValue)}`;
  } else if (error.keyword === "enum") {
    message = `must be one of ${JSON.stringify(error.params.allowedValues)}`;
  } else if (error.keyword === "discriminator") {
    const tag = String(error.params.tag);
    const tagValue = JSON.stringify(error.params.tagValue);
    path = `${path}/${escapeJsonPointer(tag)}`;
    message = `${tagValue} is not a supported ${tag}`;
  }

  return {
    severity: "error",
    path,
    keyword: error.keyword,
    params: error.params,
    message: `${path || "workflow"} ${message}`,
  };
};

export const validateWorkflow = (workflow: unknown): WorkflowIssue[] => {
  const issues: WorkflowIssue[] = [];
  if (!validateSchema(workflow)) {
    const seen = new Set<string>();
    for (const error of validateSchema.errors ?? []) {
      const issue = formatSchemaError(error);
      const key = `${issue.path}\u0000${issue.keyword}\u0000${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
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
