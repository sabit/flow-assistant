Bootstrap a compact **AI Workflow Workbench MVP** using assistant-ui as the application shell.

## Bootstrap

Start with:

```bash
npx assistant-ui@latest create
```

Use the generated assistant-ui project as the base.

Do not create a separate React/Vite scaffold unless the generated project requires it.

Add only the dependencies needed for:

- Mermaid
- AJV
- RFC 6902 JSON Patch
- Dexie / IndexedDB

Use assistant-ui's generated/recommended backend runtime for model access.

Do not implement frontend API/provider configuration.

## Product Goal

Build a lightweight workflow authoring/review tool where:

- workflow JSON is the source of truth
- AI creates or modifies workflow JSON
- users visualize the workflow
- users select a node/group and attach it to chat
- AI proposes RFC 6902 JSON Patch changes
- users review and Apply/Reject changes
- accepted changes create immutable revisions
- previous revisions can be restored
- workflows can be imported/exported through clipboard

The initial workflow profile is:

`kiosk-workflow.schema.v2.json`

Do not make the application conceptually dependent on kiosks or banking.

Do not build a drag/drop workflow editor.

## Ownership Boundary

Keep this separation:

```text
Browser
├─ workflow documents
├─ revision history
├─ Mermaid visualization
├─ schema validation
├─ semantic graph validation
├─ selected workflow context
├─ patch preview
└─ patch application

Assistant-ui backend
└─ LLM inference and tool calling
```

Principle:

**Server owns inference. Browser owns documents.**

The backend must not become authoritative for workflow state.

## Application Shell

Use assistant-ui's existing shell/primitives as much as possible.

Prefer `AssistantSidebar` as the primary application layout.

Use assistant-ui's standard `Thread` and Composer instead of building custom chat UI.

Component hierarchy:

```text
App
├─ AssistantRuntimeProvider
│
└─ WorkflowWorkbench
   ├─ ApplicationHeader
   │  ├─ ProductTitle
   │  ├─ CurrentWorkflow
   │  ├─ CurrentRevision
   │  └─ WorkflowActions
   │     ├─ New
   │     ├─ PasteWorkflow
   │     ├─ CopyWorkflow
   │     └─ History
   │
   └─ AssistantSidebar
      ├─ MainContent
      │  ├─ WorkflowViewer
      │  │  ├─ ViewerHeader
      │  │  │  ├─ WorkflowTitle
      │  │  │  ├─ ValidationStatus
      │  │  │  └─ ViewControls
      │  │  ├─ WorkflowLegend
      │  │  └─ MermaidCanvas
      │  │     ├─ WorkflowGroups
      │  │     ├─ SelectableWorkflowNodes
      │  │     └─ WorkflowEdges
      │  │
      │  └─ DetailDrawer
      │     ├─ InspectorView
      │     ├─ ProposalView
      │     └─ ValidationView
      │
      └─ AssistantPanel
         └─ assistant-ui Thread
            ├─ Messages
            │  ├─ UserMessages
            │  ├─ AssistantMessages
            │  └─ WorkflowPatchToolUI
            └─ Composer
               └─ WorkflowContextAttachments
```

Do not recreate:

- sidebar resizing
- chat scrolling
- message rendering
- composer infrastructure
- tool-call infrastructure

if assistant-ui already provides them.

## Main Workflow Area

The WorkflowViewer should occupy most of the non-chat area.

The DetailDrawer should be contextual and collapsible.

Behavior:

```text
No selection
→ maximize workflow canvas

Node/group selected
→ show InspectorView

AI patch proposed
→ show ProposalView

Validation requested
→ show ValidationView
```

Do not permanently reserve large screen space for an empty inspector.

## Workflow Adapter

Keep visualization and chat-context logic independent of the initial schema.

Create an abstraction similar to:

```ts
interface WorkflowAdapter {
  validate(workflow: unknown): WorkflowIssue[];

  getNodes(workflow: unknown): WorkflowNodeRef[];

  getEdges(workflow: unknown): WorkflowEdge[];

  getGroups(workflow: unknown): WorkflowGroupRef[];

  getNode(workflow: unknown, nodeId: string): unknown;

  buildSelectionContext(workflow: unknown, selection: WorkflowSelection): unknown;
}
```

Initial implementation:

```text
BsmartQWorkflowAdapter
```

for `kiosk-workflow.schema.v2.json`.

Do not spread B-SmartQ-specific assumptions throughout generic components.

## Workflow Visualization

Use Mermaid only as a read-only graph renderer.

Convert:

```text
workflow nodes       → Mermaid nodes
next                 → edges
transitions          → labelled edges
workflow groups      → Mermaid subgraphs
```

Use stable semantic styling by node type.

Suggested categories:

```text
input
selection
biometric
display
action
confirmation
submit
result
```

Colors belong only to the visualization layer.

Do not add visualization colors to the workflow schema.

Selected nodes should use a separate selection style, such as a stronger border, rather than replacing their semantic color.

Node labels should remain compact, for example:

```text
Date of Birth
INPUT
request.dateOfBirth
```

After Mermaid renders SVG, application code owns interaction and selection.

Do not persist Mermaid source or graph coordinates.

## Selection

Support:

- node selection
- group selection
- whole workflow attachment

Selected node state should expose:

```text
SelectedNode
├─ Identity
│  ├─ NodeId
│  ├─ Type
│  └─ Group
├─ DataSchema
│  ├─ Binding
│  ├─ Type
│  ├─ SemanticType
│  └─ Constraints
├─ UISchema
│  ├─ Renderer
│  ├─ Keyboard
│  ├─ InputMask
│  └─ DisplayMask
├─ GraphContext
│  ├─ IncomingEdges
│  └─ OutgoingEdges
└─ Actions
   └─ AddToChat
```

Inspector rendering should tolerate node types that do not contain data/UI properties.

## Add to Chat

Use assistant-ui's Composer attachment/context patterns.

When the user selects a workflow element and chooses `Add to chat`, add a compact attachment to the Composer.

Example visible attachment:

```text
Workflow node
Date of Birth (dob)
INPUT · request.dateOfBirth
```

Store the attachment internally as a reference:

```ts
interface WorkflowAttachment {
  type: "workflow_node" | "workflow_group" | "workflow";
  revisionId: string;
  nodeId?: string;
  groupId?: string;
}
```

Do not store only a mutable copy of the selected node.

When preparing model context, resolve the attachment against the referenced immutable revision.

For a node include:

- node ID
- node definition
- group metadata if applicable
- bindings
- incoming edges
- outgoing edges

For a group include the relevant group definition and member nodes.

Do not dump large raw workflow JSON into the visible composer.

## Chat Context Strategy

Prefer narrow context.

For a selected node, send:

```text
workflow identity/revision
selected node
group metadata if relevant
incoming edges
outgoing edges
user instruction
```

Do not automatically send the entire workflow.

Send the whole workflow only when:

- explicitly attached
- required to safely perform the requested modification

## Assistant UI / AI

Use assistant-ui for:

- Thread
- Composer
- messages
- streaming
- retries/regeneration
- tool calls
- custom tool rendering
- workflow context attachments where possible

Use its backend/runtime for model access.

Do not implement:

- API Base URL UI
- Model UI
- Bearer key UI
- OpenAI-compatible browser adapter

Model/provider configuration belongs to the assistant-ui backend environment.

## AI Mutation Tool

Register a workflow-specific tool:

```ts
propose_workflow_patch({
  summary,
  baseRevisionId,
  patch,
});
```

`patch` must be RFC 6902 JSON Patch.

Example:

```json
{
  "summary": "Make Date of Birth optional",
  "baseRevisionId": "rev-12",
  "patch": [
    {
      "op": "replace",
      "path": "/nodes/dob/data/constraints/required",
      "value": false
    }
  ]
}
```

The AI must never directly mutate browser workflow state.

The tool represents a proposal only.

## Patch Proposal UI

Render `propose_workflow_patch` using a custom assistant-ui tool component.

Hierarchy:

```text
WorkflowPatchToolUI
├─ Summary
├─ BaseRevision
├─ AffectedNodes
├─ ValidationStatus
│  ├─ SchemaValidation
│  └─ SemanticValidation
├─ DiffPreview
│  ├─ BeforeAfterChanges
│  └─ RawPatchToggle
└─ Actions
   ├─ Reject
   └─ Apply
```

Show concise semantic changes where possible:

```text
Date of Birth

Required
true → false
```

Raw RFC 6902 JSON should be secondary/collapsible.

## Patch Processing

When a proposal arrives:

1. locate `baseRevisionId`
2. deep-clone the workflow snapshot
3. apply the JSON Patch to the clone
4. validate resulting JSON with AJV
5. run semantic graph validation
6. determine affected nodes/groups
7. generate concise before/after changes
8. show proposal
9. wait for Apply/Reject

Never modify the current workflow before Apply.

If `baseRevisionId` is no longer the current revision, flag the proposal as stale rather than blindly applying it.

## Apply / Reject

### Apply

On Apply:

- save the complete resulting workflow as a new immutable revision
- save the original patch
- save the AI summary
- set source to `ai`
- make the new revision current
- rerender Mermaid

### Reject

Discard the proposal.

Do not create a workflow revision for rejected changes.

## Revision Model

Use immutable full snapshots.

```ts
interface WorkflowRevision {
  id: string;
  workflowId: string;
  parentRevisionId?: string;
  createdAt: string;

  source: "new" | "import" | "ai" | "restore";

  summary?: string;
  workflow: unknown;
  patch?: JsonPatchOperation[];
}
```

Store full snapshots even when a patch exists.

The snapshot is authoritative.

The patch is useful for:

- audit
- proposal display
- change explanation

## Undo / Restore

For MVP:

```text
Undo = restore a previous revision
```

Do not implement inverse-patch Ctrl+Z.

History should allow selecting a previous revision and restoring it.

Restore should create a new revision:

```text
source = restore
parentRevisionId = current revision
workflow = selected historical snapshot
```

Do not delete later history.

## Storage

Use Dexie / IndexedDB for:

```text
workflows
revisions
chatMessages
```

Use localStorage only for lightweight UI preferences if needed.

Workflow persistence remains browser-side.

The backend should remain stateless with respect to workflow documents.

## Import / Export

### Paste Workflow

Accept raw workflow JSON from clipboard.

Process:

```text
parse
→ AJV schema validation
→ semantic validation
→ create workflow + initial revision
→ render
```

Do not silently save malformed JSON or schema-invalid workflows.

### Copy Workflow

Copy only the current workflow JSON.

Do not export:

- revision metadata
- chat history
- Mermaid data
- application state

## Validation

Use two independent layers.

### JSON Schema Validation

Use AJV with:

`kiosk-workflow.schema.v2.json`

### Semantic Graph Validation

Check at least:

- `start` references an existing node
- every `next` target exists
- every transition target exists
- referenced groups exist
- malformed graph references → error
- unreachable nodes → warning
- no terminal/result node → warning

Return:

```ts
interface WorkflowIssue {
  severity: "error" | "warning";
  nodeId?: string;
  message: string;
}
```

Patch proposals with validation errors must not be applicable.

Warnings do not block Apply.

## Revision-Aware Chat Context

Chat messages/attachments should retain the revision they refer to.

Example:

```ts
interface WorkflowAttachment {
  revisionId: "rev-12";
  type: "workflow_node";
  nodeId: "dob";
}
```

If the current workflow later becomes `rev-16`, an old chat attachment must still resolve against `rev-12`.

This ensures phrases such as:

```text
"make this optional"
```

retain their original meaning.

## MVP Constraints

Do not build:

- user authentication
- workflow backend persistence
- API/provider configuration UI
- browser-side API credentials
- collaboration
- drag/drop workflow editing
- manual graph editing
- workflow execution
- Git integration
- permissions
- multi-user functionality
- complex project/project-folder management

Do not build functionality already provided adequately by assistant-ui.

## Implementation Order

1. bootstrap with `assistant-ui create`
2. understand/reuse generated AssistantSidebar + Thread structure
3. add supplied workflow schema
4. implement AJV validation
5. implement `BsmartQWorkflowAdapter`
6. implement Dexie revision store
7. implement clipboard Paste/Copy
8. implement Mermaid workflow visualization
9. add semantic node colors/classes
10. implement node/group selection
11. implement contextual DetailDrawer
12. integrate workflow attachments into assistant-ui Composer
13. resolve revision-aware context for model requests
14. implement `propose_workflow_patch`
15. apply patch to cloned revision
16. validate proposed result
17. implement custom assistant-ui patch proposal tool UI
18. implement Apply/Reject
19. implement revision history/restore

Prioritize one end-to-end vertical slice:

```text
paste workflow
→ validate
→ visualize
→ select node
→ Add to chat
→ ask AI for a change
→ receive patch proposal
→ validate patch result
→ preview change
→ Apply
→ create revision
→ rerender workflow
```

Keep everything else secondary until this works reliably.
