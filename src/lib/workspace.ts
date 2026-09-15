import type { Message } from "@ag-ui/core";
export type Citation = {
  id?: string;
  document_id: string;
  document_name: string;
  page: number;
  text?: string;
};
export type WebSource = { id?: string; title: string; url: string };
export type SearchMode = "documents" | "hybrid";
export type WebSearchStatus =
  | "disabled"
  | "pending"
  | "searching"
  | "complete"
  | "empty"
  | "failed"
  | "skipped";
export type WebSearchReason =
  "not_needed" | "no_public_query" | "planning_unavailable";
export type SearchMetadata = {
  searchMode?: SearchMode;
  webSearchStatus?: WebSearchStatus;
  webSearchReason?: WebSearchReason;
  warnings?: string[];
};
export type Turn = SearchMetadata & {
  id: string;
  messageId?: string;
  question: string;
  documentName: string;
  status: "pending" | "complete" | "error" | "stopped";
  answer?: string;
  phase?: string;
  citations?: Citation[];
  webSources?: WebSource[];
  error?: string;
};
export type Conversation = {
  id: string;
  title: string;
  documentIds: string[];
  turns: Turn[];
};
export const STORAGE_KEY = "document-ai:conversations:v2";
export function createConversation(documentIds: string[] = []): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    documentIds,
    turns: [],
  };
}
export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const WEB_SEARCH_STATUSES = [
  "disabled",
  "pending",
  "searching",
  "complete",
  "empty",
  "failed",
  "skipped",
] as const;
const WEB_SEARCH_REASONS = [
  "not_needed",
  "no_public_query",
  "planning_unavailable",
] as const;
const PUBLIC_WARNINGS = new Set([
  "Search planning was unavailable. The answer uses selected documents only.",
  "No relevant passages were found in the selected documents.",
  "Web search was unavailable. No web results were used.",
  "The answer could not be completed. Please retry.",
]);

/** Keep public execution state, never arbitrary tool/provider diagnostics. */
export function searchMetadataFromState(
  state: Record<string, unknown>,
): SearchMetadata {
  return {
    searchMode:
      state.search_mode === "hybrid" || state.search_mode === "documents"
        ? state.search_mode
        : undefined,
    webSearchStatus: WEB_SEARCH_STATUSES.includes(
      state.web_search_status as WebSearchStatus,
    )
      ? (state.web_search_status as WebSearchStatus)
      : undefined,
    webSearchReason: WEB_SEARCH_REASONS.includes(
      state.web_search_reason as WebSearchReason,
    )
      ? (state.web_search_reason as WebSearchReason)
      : undefined,
    warnings: Array.isArray(state.warnings)
      ? [
          ...new Set(
            state.warnings.filter(
              (value): value is string =>
                typeof value === "string" && PUBLIC_WARNINGS.has(value),
            ),
          ),
        ]
      : [],
  };
}
export function citationsFromState(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Citation =>
        isRecord(item) &&
        typeof item.document_id === "string" &&
        typeof item.document_name === "string" &&
        typeof item.page === "number",
    )
    .slice(0, 20)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : undefined,
      document_id: item.document_id,
      document_name: item.document_name,
      page: item.page,
    }));
}
export function webSourcesFromState(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is WebSource =>
        isRecord(item) &&
        typeof item.title === "string" &&
        typeof item.url === "string" &&
        /^https?:\/\//i.test(item.url),
    )
    .slice(0, 10)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : undefined,
      title: item.title,
      url: item.url,
    }));
}
// Restore only this account's understood display fields. Never restore tool results or reasoning.
export function restoreConversations(raw: string | null): Conversation[] {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(data)) return [];
    return data
      .filter(isRecord)
      .filter(
        (item) =>
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          Array.isArray(item.documentIds) &&
          item.documentIds.every((id) => typeof id === "string") &&
          Array.isArray(item.turns),
      )
      .slice(0, 30)
      .map((item) => ({
        id: item.id as string,
        title: item.title as string,
        documentIds: item.documentIds as string[],
        turns: (item.turns as unknown[])
          .filter(isRecord)
          .filter(
            (turn) =>
              typeof turn.id === "string" &&
              typeof turn.question === "string" &&
              typeof turn.documentName === "string" &&
              ["pending", "complete", "error", "stopped"].includes(
                String(turn.status),
              ),
          )
          .map((turn) => ({
            id: turn.id as string,
            messageId:
              typeof turn.messageId === "string" ? turn.messageId : undefined,
            question: turn.question as string,
            documentName: turn.documentName as string,
            status:
              turn.status === "pending"
                ? "stopped"
                : (turn.status as Turn["status"]),
            answer: typeof turn.answer === "string" ? turn.answer : undefined,
            error: typeof turn.error === "string" ? turn.error : undefined,
            citations: citationsFromState(turn.citations),
            webSources: webSourcesFromState(turn.webSources),
            ...searchMetadataFromState({
              search_mode: turn.searchMode,
              web_search_status: turn.webSearchStatus,
              web_search_reason: turn.webSearchReason,
              warnings: turn.warnings,
            }),
          })),
      }));
  } catch {
    return [];
  }
}
export function conversationMessages(
  conversation: Conversation,
  beforeTurnId?: string,
): Message[] {
  const messages: Message[] = [];
  for (const turn of conversation.turns) {
    if (turn.id === beforeTurnId) break;
    if (turn.status !== "complete" || !turn.answer) continue;
    messages.push(
      { id: turn.messageId ?? turn.id, role: "user", content: turn.question },
      { id: `${turn.id}:answer`, role: "assistant", content: turn.answer },
    );
  }
  return messages;
}
export function conversationMarkdown(conversation: Conversation): string {
  return [
    `# ${conversation.title}`,
    ...conversation.turns.flatMap((turn) => [
      `## ${turn.question}`,
      `Documents: ${turn.documentName}`,
      turn.searchMode
        ? `Search mode: ${turn.searchMode === "hybrid" ? "Documents + web" : "Documents"}`
        : "",
      turn.webSearchStatus
        ? `Web search: ${turn.webSearchStatus}${turn.webSearchReason ? ` (${turn.webSearchReason.replaceAll("_", " ")})` : ""}`
        : "",
      turn.answer || `Response ${turn.status}.`,
      turn.error || "",
      ...(turn.warnings ?? []),
      ...(turn.citations ?? []).map(
        (source) =>
          `- ${source.id ? `[${source.id}] ` : ""}${source.document_name}, page ${source.page}`,
      ),
      ...(turn.webSources ?? []).map(
        (source) =>
          `- ${source.id ? `[${source.id}] ` : ""}[${source.title}](${source.url})`,
      ),
    ]),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function phaseLabel(phase?: string): string {
  const labels: Record<string, string> = {
    planning: "Preparing your question",
    retrieving: "Searching your documents",
    retrieval: "Searching your documents",
    searching: "Searching the web",
    web_search: "Searching the web",
    generating: "Writing your answer",
    answering: "Writing your answer",
    retrying: "Retrying the request",
    complete: "Answer complete",
  };
  return labels[phase ?? ""] || "Working on your question";
}
