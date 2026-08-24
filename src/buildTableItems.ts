import { isSkillsBudgetSectionLabel } from './skill-management-session.js';
import type { ParsedPrompt, TableItem } from './types.js';

/** Return whether a row is signed reconciliation rather than positive burden. */
export function isNonPositivePromptBoundaryReconciliation(row: {
  label: string;
  tokens: number;
}): boolean {
  return row.label === 'Prompt Boundary Overhead' && row.tokens <= 0;
}

function percentageOfTotal(row: { label: string; tokens: number }, totalTokens: number): number {
  return totalTokens > 0 && !isNonPositivePromptBoundaryReconciliation(row)
    ? (row.tokens / totalTokens) * 100
    : 0;
}

/** Convert ParsedPrompt sections into TableItems sorted by tokens desc. */
export function buildTableItems(parsed: ParsedPrompt): TableItem[] {
  return parsed.sections
    .map((section): TableItem => {
      const pct = percentageOfTotal(section, parsed.totalTokens);

      const children: TableItem[] | undefined = section.children?.length
        ? section.children
            .map(
              (child): TableItem => ({
                label: child.label,
                tokens: child.tokens,
                chars: child.chars,
                pct: percentageOfTotal(child, parsed.totalTokens),
                drillable: false,
                content: child.content,
              }),
            )
            .toSorted((a, b) => b.tokens - a.tokens)
        : undefined;

      return {
        label: section.label,
        tokens: section.tokens,
        chars: section.chars,
        pct,
        drillable:
          (children?.length ?? 0) > 0 ||
          Boolean(section.tools) ||
          isSkillsBudgetSectionLabel(section.label),
        content: section.content,
        tools: section.tools,
        children,
      };
    })
    .toSorted((a, b) => b.tokens - a.tokens);
}
