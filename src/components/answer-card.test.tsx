import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerCard, type AnswerTurn } from "./answer-card";

const completeTurn: AnswerTurn = {
  id: "turn-1",
  question: "What are the key findings?",
  answer:
    "The document describes **three findings**. [More context](https://example.com/context)",
  status: "complete",
  documentName: "Research report.pdf",
};

afterEach(() => vi.unstubAllGlobals());

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

  it("toggles read aloud and releases speech handlers on unmount", () => {
    class MockUtterance {
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
    vi.stubGlobal("speechSynthesis", { speak, cancel });
    const { unmount } = render(
      <AnswerCard
        turn={completeTurn}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));
    const firstUtterance = speak.mock.calls[0][0] as MockUtterance;
    expect(firstUtterance.text).toContain("three findings");
    expect(
      screen.getByRole("button", { name: "Stop reading answer" }),
    ).toHaveAttribute("aria-pressed", "true");
    act(() => firstUtterance.onend?.());
    fireEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));
    const secondUtterance = speak.mock.calls[1][0] as MockUtterance;
    unmount();
    expect(secondUtterance.onend).toBeNull();
    expect(secondUtterance.onerror).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(3);
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
