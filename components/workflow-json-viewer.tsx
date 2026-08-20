"use client";

import { json } from "@codemirror/lang-json";
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { WorkflowIssue } from "@/lib/workflow/types";

type JsonNode = {
  name: string;
  from: number;
  to: number;
  firstChild: JsonNode | null;
  lastChild: JsonNode | null;
  nextSibling: JsonNode | null;
};

const decodePointer = (path = "") =>
  path
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));

const valueChildren = (node: JsonNode) => {
  const children: JsonNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!["[", "]", "{", "}", ","].includes(child.name)) children.push(child);
  }
  return children;
};

const findPointerNode = (state: EditorState, path?: string): JsonNode => {
  const tree = syntaxTree(state);
  let node: JsonNode = (tree.topNode.firstChild ?? tree.topNode) as JsonNode;

  for (const segment of decodePointer(path)) {
    if (node.name === "Object") {
      const property: JsonNode | undefined = valueChildren(node).find((candidate) => {
        if (candidate.name !== "Property" || !candidate.firstChild) return false;
        try {
          return (
            JSON.parse(
              state.doc.sliceString(candidate.firstChild.from, candidate.firstChild.to),
            ) === segment
          );
        } catch {
          return false;
        }
      });
      if (!property?.lastChild) return node;
      node = property.lastChild;
    } else if (node.name === "Array") {
      const index = Number(segment);
      const child: JsonNode | undefined = valueChildren(node)[index];
      if (!child) return node;
      node = child;
    } else {
      return node;
    }
  }
  return node;
};

export function WorkflowJsonViewer({
  document,
  issues,
}: {
  document: unknown;
  issues: WorkflowIssue[];
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const source = JSON.stringify(document, null, 2);
    const schemaLinter = linter(
      (view): Diagnostic[] =>
        issues.map((issue) => {
          const node = findPointerNode(view.state, issue.path);
          return {
            from: node.from,
            to: Math.max(node.from + 1, node.to),
            severity: issue.severity,
            source: "Workflow schema",
            message: issue.message,
            markClass: issue.severity === "error" ? "cm-schema-error" : "cm-schema-warning",
          };
        }),
      { delay: 0 },
    );
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source,
        extensions: [
          lineNumbers(),
          json(),
          syntaxHighlighting(defaultHighlightStyle),
          schemaLinter,
          lintGutter(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "12px", backgroundColor: "#ffffff", color: "#0f172a" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            },
            ".cm-gutters": {
              backgroundColor: "#f8fafc",
              color: "#94a3b8",
              borderRight: "1px solid #e2e8f0",
            },
            ".cm-activeLine": { backgroundColor: "#f8fafc" },
            ".cm-activeLineGutter": { backgroundColor: "#f1f5f9" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "#bae6fd !important",
            },
            ".cm-schema-error": {
              textDecoration: "underline wavy #fb7185 1.5px",
              backgroundColor: "#ffe4e6",
            },
            ".cm-schema-warning": {
              textDecoration: "underline wavy #fbbf24 1.5px",
              backgroundColor: "#fef3c7",
            },
            ".cm-lintRange-error": { backgroundImage: "none" },
            ".cm-lintRange-warning": { backgroundImage: "none" },
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [document, issues]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
