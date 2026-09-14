export type Turn = {
  id: string;
  question: string;
  documentName: string;
  status: "pending" | "complete" | "error" | "stopped";
  ragAnswer?: string;
  mcpAnswer?: string;
  error?: string;
};

export type DocumentInfo = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
};
export type Conversation = {
  id: string;
  title: string;
  document: DocumentInfo | null;
  turns: Turn[];
};
export const STORAGE_KEY = "document-ai:conversations:v1";
export const EMPTY_CONVERSATION: Conversation = {
  id: "welcome",
  title: "New conversation",
  document: null,
  turns: [],
};

export function createConversation(
  document: DocumentInfo | null = null,
): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    document,
    turns: [],
  };
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Browser storage may be stale or edited. Only restore the fields this UI understands.
export function restoreConversations(raw: string | null): Conversation[] {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(data)) return [];
    return data
      .slice(0, 30)
      .filter((item) => {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          typeof item.title !== "string" ||
          !Array.isArray(item.turns)
        )
          return false;
        const doc = item.document;
        return (
          doc === null ||
          (isRecord(doc) &&
            typeof doc.id === "string" &&
            typeof doc.name === "string" &&
            typeof doc.size === "number" &&
            typeof doc.lastModified === "number")
        );
      })
      .map((item) => ({
        id: item.id,
        title: item.title,
        document: item.document,
        turns: item.turns
          .filter(
            (turn: unknown) =>
              isRecord(turn) &&
              typeof turn.id === "string" &&
              typeof turn.question === "string" &&
              typeof turn.documentName === "string" &&
              ["pending", "complete", "error", "stopped"].includes(
                String(turn.status),
              ) &&
              (turn.ragAnswer === undefined ||
                typeof turn.ragAnswer === "string") &&
              (turn.mcpAnswer === undefined ||
                typeof turn.mcpAnswer === "string") &&
              (turn.error === undefined || typeof turn.error === "string"),
          )
          .map((turn: Turn) => ({
            id: turn.id,
            question: turn.question,
            documentName: turn.documentName,
            status: turn.status === "pending" ? "stopped" : turn.status,
            ragAnswer: turn.ragAnswer,
            mcpAnswer: turn.mcpAnswer,
            error: turn.error,
          })),
      }));
  } catch {
    return [];
  }
}

export function conversationMarkdown(conversation: Conversation): string {
  return [
    `# ${conversation.title}`,
    conversation.document ? `Document: ${conversation.document.name}` : "",
    ...conversation.turns.flatMap((turn) => [
      `## ${turn.question}`,
      ...(turn.status === "complete"
        ? [
            "### Document answer",
            turn.ragAnswer || "No document answer returned.",
            "### Web answer",
            turn.mcpAnswer || "No web answer returned.",
          ]
        : [`Response ${turn.status}.`, turn.error || ""]),
    ]),
  ]
    .filter(Boolean)
    .join("\n\n");
}
