import type { WorkflowDocument, WorkflowNode, WorkflowSelection } from "@/lib/workflow/types";

export type WorkflowNodeRef = {
  id: string;
  node: WorkflowNode;
  label: string;
  groupId?: string;
};

export type WorkflowEdge = { from: string; to: string; label?: string };

export type WorkflowGroupRef = {
  id: string;
  label: string;
  nodeIds: string[];
};

export interface WorkflowAdapter {
  getNodes(workflow: WorkflowDocument): WorkflowNodeRef[];
  getEdges(workflow: WorkflowDocument): WorkflowEdge[];
  getGroups(workflow: WorkflowDocument): WorkflowGroupRef[];
  getNode(workflow: WorkflowDocument, nodeId: string): WorkflowNode | undefined;
  buildSelectionContext(workflow: WorkflowDocument, selection: WorkflowSelection): unknown;
}

export const getNodeLabel = (nodeId: string, node: WorkflowNode) =>
  node.presentation?.title?.en ?? node.binding ?? nodeId;

export class BsmartQWorkflowAdapter implements WorkflowAdapter {
  getNodes(workflow: WorkflowDocument): WorkflowNodeRef[] {
    return Object.entries(workflow.nodes).map(([id, node]) => ({
      id,
      node,
      label: getNodeLabel(id, node),
      groupId: node.group,
    }));
  }

  getEdges(workflow: WorkflowDocument): WorkflowEdge[] {
    return this.getNodes(workflow).flatMap(({ id, node }) => {
      const edges: WorkflowEdge[] = node.next ? [{ from: id, to: node.next }] : [];
      for (const transition of node.transitions ?? []) {
        edges.push({
          from: id,
          to: transition.to,
          label: transition.default ? "default" : transition.when,
        });
      }
      for (const key of ["onSuccess", "onFailure", "onBusinessError", "onSystemError"]) {
        const target = node[key];
        if (typeof target === "string") edges.push({ from: id, to: target, label: key });
      }
      return edges;
    });
  }

  getGroups(workflow: WorkflowDocument): WorkflowGroupRef[] {
    const groups = workflow.groups ?? {};
    return Object.entries(groups)
      .map(([id, group]) => ({
        id,
        label: group.label.en ?? id,
        nodeIds: this.getNodes(workflow)
          .filter((node) => node.groupId === id)
          .map((node) => node.id),
      }))
      .sort(
        (a, b) =>
          (groups[a.id]?.sequence ?? Number.MAX_SAFE_INTEGER) -
          (groups[b.id]?.sequence ?? Number.MAX_SAFE_INTEGER),
      );
  }

  getNode(workflow: WorkflowDocument, nodeId: string) {
    return workflow.nodes[nodeId];
  }

  buildSelectionContext(workflow: WorkflowDocument, selection: WorkflowSelection) {
    const edges = this.getEdges(workflow);
    if (selection.type === "workflow") {
      return { workflow: { version: workflow.version, description: workflow.description } };
    }
    if (selection.type === "group") {
      const group = this.getGroups(workflow).find((item) => item.id === selection.groupId);
      return {
        group,
        members: group?.nodeIds.map((id) => ({ id, ...workflow.nodes[id] })) ?? [],
      };
    }
    const node = workflow.nodes[selection.nodeId];
    return {
      nodeId: selection.nodeId,
      node,
      group: node?.group ? workflow.groups?.[node.group] : undefined,
      incomingEdges: edges.filter((edge) => edge.to === selection.nodeId),
      outgoingEdges: edges.filter((edge) => edge.from === selection.nodeId),
    };
  }
}

export const workflowAdapter = new BsmartQWorkflowAdapter();
