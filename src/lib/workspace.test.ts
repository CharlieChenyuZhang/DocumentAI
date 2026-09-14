import { describe, expect, it } from "vitest";
import {
  citationsFromState,
  conversationMessages,
  restoreConversations,
  webSourcesFromState,
} from "./workspace";

describe("safe conversation snapshots", () => {
  it("restores interrupted turns as stopped without restoring raw tools or reasoning", () => {
    const [conversation] = restoreConversations(
      JSON.stringify([
        {
          id: "chat-a",
          title: "Private research",
          documentIds: ["doc-a"],
          turns: [
            {
              id: "turn-a",
              messageId: "attempt-a",
              question: "Question",
              documentName: "Report.pdf",
              status: "pending",
              answer: "Partial answer",
              reasoning: "hidden",
              toolResult: "private",
              citations: [],
              webSources: [],
            },
          ],
        },
      ]),
    );
    expect(conversation.turns[0]).toMatchObject({
      id: "turn-a",
      messageId: "attempt-a",
      status: "stopped",
      answer: "Partial answer",
    });
    expect(conversation.turns[0]).not.toHaveProperty("reasoning");
    expect(conversation.turns[0]).not.toHaveProperty("toolResult");
    expect(conversationMessages(conversation)).toEqual([]);
  });
  it("does not accept the obsolete single-document snapshot or malformed identities", () => {
    expect(
      restoreConversations(
        JSON.stringify([
          { id: "old", title: "Old", document: { id: "old" }, turns: [] },
          { id: 4, title: "Malformed", documentIds: [], turns: [] },
        ]),
      ),
    ).toEqual([]);
  });
  it("keeps citation IDs while dropping tool excerpts and rejects non-web source URLs", () => {
    const sources = [
      {
        id: "D1",
        kind: "document",
        document_id: "doc-a",
        document_name: "One.pdf",
        page: 2,
        text: "raw retrieved text",
      },
      {
        id: "W1",
        kind: "web",
        title: "Good",
        url: "https://example.com",
        text: "raw web text",
      },
      { id: "W2", kind: "web", title: "Bad", url: "javascript:alert(1)" },
    ];
    expect(citationsFromState(sources)).toEqual([
      { id: "D1", document_id: "doc-a", document_name: "One.pdf", page: 2 },
    ]);
    expect(webSourcesFromState(sources)).toEqual([
      { id: "W1", title: "Good", url: "https://example.com" },
    ]);
  });
  it("restores complete attempts with their original message IDs and omits a retried turn", () => {
    const conversation = {
      id: "chat",
      title: "Research",
      documentIds: ["doc"],
      turns: [
        {
          id: "turn-1",
          messageId: "attempt-2",
          question: "First",
          documentName: "One.pdf",
          status: "complete" as const,
          answer: "Answer",
        },
        {
          id: "turn-2",
          messageId: "attempt-3",
          question: "Second",
          documentName: "One.pdf",
          status: "error" as const,
        },
      ],
    };
    expect(conversationMessages(conversation, "turn-2")).toEqual([
      { id: "attempt-2", role: "user", content: "First" },
      { id: "turn-1:answer", role: "assistant", content: "Answer" },
    ]);
  });
});
