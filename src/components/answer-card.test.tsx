import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerCard, type AnswerTurn } from "./answer-card";
import { readAloud } from "../lib/read-aloud";

const completeTurn: AnswerTurn = {
  id: "turn-1",
  question: "What are the key findings?",
  answer:
    "The document describes **three findings**. [More context](https://example.com/context)",
  status: "complete",
  documentName: "Research report.pdf",
};

afterEach(() => {
  act(() => readAloud.stop());
  vi.unstubAllGlobals();
});

describe("AnswerCard", () => {
  it("renders unified streamed answers with safe Markdown", () => {
    const { container } = render(
      <AnswerCard
        turn={{
          ...completeTurn,
          answer:
            "**A finding**\n\n<script>alert('untrusted')</script>\n\n![External image](https://example.com/track.png)\n\n[Unsafe](javascript:alert(1))\n\n[More context](https://example.com/context)",
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "Answer" })).getByText(
        "A finding",
      ).tagName,
    ).toBe("STRONG");
    expect(
      within(screen.getByRole("region", { name: "Answer" })).getByRole("link", {
        name: "More context",
      }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Research report.pdf")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[Image: External image]")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Unsafe" }),
    ).not.toBeInTheDocument();
  });

  it("copies the unified answer and acknowledges success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <AnswerCard
        turn={completeTurn}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(
      await screen.findByRole("button", { name: "Answer copied" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(completeTurn.answer);
  });

  it("reports clipboard permission failure", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
    });
    render(
      <AnswerCard
        turn={completeTurn}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(
      await screen.findByText(
        "Couldn’t copy. Please select and copy the answer.",
      ),
    ).toBeInTheDocument();
  });

  it("shows honest pending, error, and stopped states with retry gating", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <AnswerCard
        turn={{ ...completeTurn, status: "pending", answer: "" }}
        onRetry={retry}
        retryDisabled
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Working on your question",
    );
    expect(
      screen.queryByRole("button", { name: "Copy answer" }),
    ).not.toBeInTheDocument();
    rerender(
      <AnswerCard
        turn={{
          ...completeTurn,
          status: "error",
          error: "The service is unavailable.",
        }}
        onRetry={retry}
        retryDisabled
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The service is unavailable.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    rerender(
      <AnswerCard
        turn={{ ...completeTurn, status: "stopped" }}
        onRetry={retry}
        retryDisabled={false}
      />,
    );
    expect(screen.getByText("Response stopped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("uses OpenAI narration for the rendered answer and cancels when it changes", async () => {
    class MockAudio {
      pause = vi.fn();
      removeAttribute = vi.fn();
      load = vi.fn();
    }
    vi.stubGlobal("Audio", MockAudio);
    const fetchAudio = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchAudio);
    const { rerender, unmount } = render(
      <AnswerCard
        turn={{
          ...completeTurn,
          answer: "**A finding** [D1][W1].",
          citations: [documentSource],
          webSources: [webSource],
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(fetchAudio).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));
    expect(JSON.parse(fetchAudio.mock.calls[0][1].body)).toEqual({
      text: "A finding.",
    });
    expect(screen.getByText("Preparing OpenAI AI voice…")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Stop reading answer" }),
    ).toHaveAttribute("aria-pressed", "true");
    const firstSignal = fetchAudio.mock.calls[0][1].signal as AbortSignal;
    rerender(
      <AnswerCard
        turn={{ ...completeTurn, answer: "Updated answer." }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(firstSignal.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Read answer aloud" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));
    const secondSignal = fetchAudio.mock.calls[1][1].signal as AbortSignal;
    unmount();
    expect(secondSignal.aborted).toBe(true);
  });

  it("resets the first answer when another answer starts reading", () => {
    class MockAudio {
      pause = vi.fn();
      removeAttribute = vi.fn();
      load = vi.fn();
    }
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const first = render(
      <AnswerCard
        turn={completeTurn}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    const second = render(
      <AnswerCard
        turn={{ ...completeTurn, id: "turn-2", question: "Second question?" }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    fireEvent.click(
      within(first.container).getByRole("button", {
        name: "Read answer aloud",
      }),
    );
    fireEvent.click(
      within(second.container).getByRole("button", {
        name: "Read answer aloud",
      }),
    );
    expect(
      within(first.container).getByRole("button", {
        name: "Read answer aloud",
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(second.container).getByRole("button", {
        name: "Stop reading answer",
      }),
    ).toBeVisible();
    first.unmount();
    expect(
      within(second.container).getByRole("button", {
        name: "Stop reading answer",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(second.container).getByRole("button", {
        name: "Stop reading answer",
      }),
    );
    expect(readAloud.getSnapshot().phase).toBe("idle");
  });
});

it("shows partial text and source markers while keeping completed-answer actions unavailable", () => {
  render(
    <AnswerCard
      turn={{
        ...completeTurn,
        status: "pending",
        phase: "retrieving",
        answer: "A partial finding [D1].",
        citations: [
          { id: "D1", document_id: "doc-1", document_name: "One.pdf", page: 2 },
        ],
        webSources: [
          { id: "W1", title: "Unsafe source", url: "javascript:alert(1)" },
        ],
      }}
      onRetry={vi.fn()}
      retryDisabled
    />,
  );
  expect(screen.getByRole("region", { name: "Answer" })).toHaveTextContent(
    "partial finding",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Searching your documents",
  );
  expect(
    screen.queryByRole("button", { name: "Copy answer" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("[D1] One.pdf, page 2")).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Unsafe source" }),
  ).not.toBeInTheDocument();
});

const documentSource = {
  id: "D1",
  document_id: "doc-1",
  document_name: "Research report.pdf",
  page: 2,
};
const webSource = {
  id: "W1",
  title: "Public research update",
  url: "https://example.com/research",
};

describe("answer search provenance", () => {
  it("identifies actual hybrid results and exposes document and web source counts separately", () => {
    render(
      <AnswerCard
        turn={{
          ...completeTurn,
          searchMode: "hybrid",
          webSearchStatus: "complete",
          citations: [documentSource],
          webSources: [webSource],
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(screen.getByText("Hybrid search")).toBeVisible();
    expect(screen.getByText("Documents + web")).toBeVisible();
    expect(screen.getByText("Document sources (1)")).toBeVisible();
    expect(screen.getByText("Web sources (1)")).toBeVisible();
    expect(screen.getByRole("list", { name: "Web sources" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "[W1] Public research update" }),
    ).toHaveAttribute("href", webSource.url);
    const documents = screen
      .getByText("Document sources (1)")
      .closest("details");
    expect(documents).not.toHaveAttribute("open");
    expect(
      screen.getByText("Web sources (1)").closest("details"),
    ).toHaveAttribute("open");
  });

  it.each([
    [
      "failed",
      undefined,
      "Web search was unavailable. No web sources were added.",
    ],
    [
      "empty",
      undefined,
      "Web search returned no results. No web sources were added.",
    ],
    ["skipped", "not_needed", "Web search was not needed for this question."],
    [
      "skipped",
      "no_public_query",
      "Web search was skipped because no safe public query was available. Add a public topic to your question to search the web.",
    ],
    [
      "skipped",
      "planning_unavailable",
      "Web search was skipped because search planning was unavailable.",
    ],
  ] as const)(
    "explains %s web search without claiming a hybrid answer",
    (status, reason, detail) => {
      render(
        <AnswerCard
          turn={{
            ...completeTurn,
            searchMode: "hybrid",
            webSearchStatus: status,
            webSearchReason: reason,
            citations: [documentSource],
          }}
          onRetry={vi.fn()}
          retryDisabled={false}
        />,
      );
      expect(screen.getByText(detail)).toBeVisible();
      expect(screen.queryByText("Hybrid search")).not.toBeInTheDocument();
      expect(screen.queryByText("Web sources (0)")).not.toBeInTheDocument();
    },
  );

  it("does not count unsafe web URLs or invalid document references", () => {
    render(
      <AnswerCard
        turn={{
          ...completeTurn,
          searchMode: "hybrid",
          webSearchStatus: "complete",
          citations: [documentSource, { ...documentSource, page: -1 }],
          webSources: [
            { ...webSource, url: "javascript:alert(1)" },
            { ...webSource, url: "https://" },
            { ...webSource, url: "https://user:secret@example.com" },
          ],
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(screen.getByText("Document sources (1)")).toBeVisible();
    expect(screen.queryByText("Hybrid search")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Web sources" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("No web sources are available for this answer."),
    ).toBeVisible();
  });

  it("keeps legacy source-only answers honest and uses per-turn mode for new answers", () => {
    const { rerender } = render(
      <AnswerCard
        turn={{ ...completeTurn, citations: [documentSource] }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(screen.getByText("Document sources")).toBeVisible();
    expect(screen.queryByText(/Web search was/)).not.toBeInTheDocument();
    expect(screen.queryByText("Hybrid search")).not.toBeInTheDocument();
    rerender(
      <AnswerCard
        turn={{
          ...completeTurn,
          citations: [documentSource],
          searchMode: "documents",
          webSearchStatus: "disabled",
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(
      screen.getByText("Web search was off for this answer."),
    ).toBeVisible();
    rerender(
      <AnswerCard
        turn={{
          ...completeTurn,
          citations: [documentSource],
          webSources: [webSource],
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(screen.getByText("Hybrid search")).toBeVisible();
  });

  it.each([
    ["pending", "Web search is pending."],
    ["searching", "Searching the web…"],
  ] as const)("shows %s search before an answer arrives", (status, detail) => {
    render(
      <AnswerCard
        turn={{
          ...completeTurn,
          answer: "",
          status: "pending",
          searchMode: "hybrid",
          webSearchStatus: status,
        }}
        onRetry={vi.fn()}
        retryDisabled
      />,
    );
    expect(screen.getByText(detail)).toBeVisible();
    expect(screen.queryByText("Hybrid search")).not.toBeInTheDocument();
  });

  it("does not leave a stopped answer displaying an ongoing search", () => {
    render(
      <AnswerCard
        turn={{
          ...completeTurn,
          status: "stopped",
          searchMode: "hybrid",
          webSearchStatus: "searching",
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(screen.getByText("Web search did not finish.")).toBeVisible();
    expect(screen.queryByText("Searching the web…")).not.toBeInTheDocument();
  });

  it.each([
    [
      "failed",
      undefined,
      "Web search was unavailable. No web results were used.",
    ],
    [
      "skipped",
      "planning_unavailable",
      "Search planning was unavailable. The answer uses selected documents only.",
    ],
  ] as const)(
    "shows one %s explanation while preserving document warnings",
    (status, reason, warning) => {
      render(
        <AnswerCard
          turn={{
            ...completeTurn,
            searchMode: "hybrid",
            webSearchStatus: status,
            webSearchReason: reason,
            warnings: [
              warning,
              "No relevant passages were found in the selected documents.",
            ],
          }}
          onRetry={vi.fn()}
          retryDisabled={false}
        />,
      );
      expect(screen.queryByText(warning)).not.toBeInTheDocument();
      expect(
        screen.getByText(/Web search was (unavailable|skipped)/),
      ).toBeVisible();
      expect(
        screen.getByText(
          "No relevant passages were found in the selected documents.",
        ),
      ).toBeVisible();
    },
  );

  it("shows known service warnings supplied with an answer", () => {
    render(
      <AnswerCard
        turn={{
          ...completeTurn,
          warnings: [
            "No relevant passages were found in the selected documents.",
          ],
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(
      screen.getByText(
        "No relevant passages were found in the selected documents.",
      ),
    ).toBeVisible();
  });
});
