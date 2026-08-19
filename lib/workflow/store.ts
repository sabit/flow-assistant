import Dexie, { type EntityTable } from "dexie";
import type { WorkflowRecord, WorkflowRevision } from "@/lib/workflow/types";

class WorkflowDatabase extends Dexie {
  workflows!: EntityTable<WorkflowRecord, "id">;
  revisions!: EntityTable<WorkflowRevision, "id">;
  chatMessages!: EntityTable<
    { id: string; workflowId: string; revisionId?: string; createdAt: string },
    "id"
  >;

  constructor() {
    super("flow-assistant");
    this.version(1).stores({
      workflows: "id, updatedAt",
      revisions: "id, workflowId, createdAt",
      chatMessages: "id, workflowId, revisionId, createdAt",
    });
  }
}

export const workflowDb = new WorkflowDatabase();
