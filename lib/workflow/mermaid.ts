import { getNodeLabel, workflowAdapter } from "@/lib/workflow/adapter";
import type { WorkflowDocument } from "@/lib/workflow/types";

const safeId = (id: string) => `node_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
const escape = (value: string) =>
  value.replace(
    /["&<>]/g,
    (char) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!,
  );

export const workflowToMermaid = (workflow: WorkflowDocument, selectedNodeId?: string) => {
  const groups = workflowAdapter.getGroups(workflow);
  const grouped = new Set(groups.flatMap((group) => group.nodeIds));
  const lines = ["flowchart LR"];
  const renderNode = (id: string) => {
    const node = workflow.nodes[id];
    const label = [getNodeLabel(id, node), node.type.toUpperCase(), node.binding]
      .filter(Boolean)
      .map((value) => escape(String(value)))
      .join("<br/>");
    lines.push(`${safeId(id)}["${label}"]`);
  };
  for (const group of groups) {
    lines.push(`subgraph group_${group.id}["${escape(group.label)}"]`);
    group.nodeIds.forEach(renderNode);
    lines.push("end");
  }
  Object.keys(workflow.nodes)
    .filter((id) => !grouped.has(id))
    .forEach(renderNode);
  for (const edge of workflowAdapter.getEdges(workflow)) {
    if (!workflow.nodes[edge.to]) continue;
    lines.push(
      `${safeId(edge.from)} ${edge.label ? `-- "${escape(edge.label)}" -->` : "-->"} ${safeId(edge.to)}`,
    );
  }
  const types = new Set(Object.values(workflow.nodes).map((node) => node.type));
  const palette: Record<string, string> = {
    input: "#dbeafe,#1d4ed8",
    selection: "#f3e8ff,#7e22ce",
    biometric: "#ffe4e6,#be123c",
    display: "#ecfccb,#3f6212",
    action: "#ffedd5,#c2410c",
    confirmation: "#fef3c7,#a16207",
    submit: "#cffafe,#0e7490",
    result: "#dcfce7,#15803d",
  };
  for (const type of types) {
    const [fill, stroke] = (palette[type] ?? "#f3f4f6,#4b5563").split(",");
    lines.push(`classDef ${type} fill:${fill},stroke:${stroke},stroke-width:1.5px,color:#172033;`);
  }
  lines.push("classDef selected stroke-width:1.5px,rx:8,ry:8;");
  for (const [id, node] of Object.entries(workflow.nodes)) {
    lines.push(`class ${safeId(id)} ${node.type}${id === selectedNodeId ? ",selected" : ""};`);
    lines.push(`click ${safeId(id)} workflowSelect "Select ${escape(getNodeLabel(id, node))}"`);
  }
  return lines.join("\n");
};
