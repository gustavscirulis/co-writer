import { create } from "zustand";

export type AgentEditSummary = { added: number; removed: number };

interface AgentEditSummaryState {
  byPath: ReadonlyMap<string, AgentEditSummary>;
}

/** Each note's latest Co-writer edit, as counted by its editor view, for the footer. */
const useAgentEditSummaryStore = create<AgentEditSummaryState>(() => ({ byPath: new Map() }));

export function setAgentEditSummary(path: string, summary: AgentEditSummary | null) {
  const { byPath } = useAgentEditSummaryStore.getState();
  if ((byPath.get(path) ?? null) === summary) return;
  const next = new Map(byPath);
  if (summary) next.set(path, summary);
  else next.delete(path);
  useAgentEditSummaryStore.setState({ byPath: next });
}

export function useAgentEditSummary(path: string) {
  return useAgentEditSummaryStore((s) => s.byPath.get(path) ?? null);
}
