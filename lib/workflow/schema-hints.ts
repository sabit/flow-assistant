import hints from "@/docs/workflow-schema-hints.json";
import type { WorkflowIssue } from "@/lib/workflow/types";

type HintMatcher = {
  keyword?: string;
  path?: string;
  message?: string;
  params?: Record<string, unknown>;
};

type HintRule = {
  when: HintMatcher;
  hint: string;
  pathPattern?: RegExp;
  messagePattern?: RegExp;
};

const compileRule = ({ when, hint }: { when: HintMatcher; hint: string }): HintRule => ({
  when,
  hint,
  pathPattern: when.path ? new RegExp(when.path) : undefined,
  messagePattern: when.message ? new RegExp(when.message) : undefined,
});

const hintConfig = hints as unknown as { rules: { when: HintMatcher; hint: string }[] };
const rules = hintConfig.rules.map(compileRule);

const ruleMatches = (issue: WorkflowIssue, rule: HintRule) => {
  const { keyword, params } = rule.when;
  if (keyword !== undefined && issue.keyword !== keyword) return false;
  if (
    params &&
    !Object.entries(params).every(
      ([key, value]) =>
        (issue.params as Record<string, unknown> | undefined)?.[key] === value,
    )
  ) {
    return false;
  }
  if (rule.pathPattern && !rule.pathPattern.test(issue.path ?? "")) return false;
  if (rule.messagePattern && !rule.messagePattern.test(issue.message)) return false;
  return true;
};

export type HintedWorkflowIssue = WorkflowIssue & { hint?: string };

export const withSchemaHints = (issues: WorkflowIssue[]): HintedWorkflowIssue[] =>
  issues.map((issue) => {
    const rule = rules.find((candidate) => ruleMatches(issue, candidate));
    return rule ? { ...issue, hint: rule.hint } : issue;
  });

export const formatIssueWithHint = ({ message, hint }: HintedWorkflowIssue) =>
  hint ? `${message} Fix: ${hint}` : message;
