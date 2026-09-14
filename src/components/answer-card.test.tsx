import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerCard, type AnswerTurn } from "./answer-card";

const completeTurn: AnswerTurn = {
  id: "turn-1",
  question: "What are the key findings?",
  ragAnswer: "The document describes **three findings**.",
  mcpAnswer: "[More context](https://example.com/context)",
  status: "complete",
  documentName: "Research report.pdf",
};

afterEach(() => vi.unstubAllGlobals());

describe("AnswerCard", () => {
  it("keeps document and web answers distinct and renders safe Markdown", () => {
    const { container } = render(
      <AnswerCard
        turn={{
          ...completeTurn,
          ragAnswer:
            "**A finding**\n\n<script>alert('untrusted')</script>\n\n![External image](https://example.com/track.png)\n\n[Unsafe](javascript:alert(1))",
        }}
        onRetry={vi.fn()}
        retryDisabled={false}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "Document answer" })).getByText(
        "A finding",
      ).tagName,
    ).toBe("STRONG");
    expect(
      within(screen.getByRole("region", { name: "Web answer" })).getByRole(
        "link",
        { name: "More context" },
      ),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Research report.pdf")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[Image: External image]")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Unsafe" }),
    ).not.toBeInTheDocument();
  });

  it("copies both complete answers and acknowledges success", async () => {
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
    expect(writeText).toHaveBeenCalledWith(
      `Document answer\n\n${completeTurn.ragAnswer}\n\nWeb answer\n\n${completeTurn.mcpAnswer}`,
    );
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
        turn={{ ...completeTurn, status: "pending" }}
        onRetry={retry}
        retryDisabled
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading your document and searching the web",
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
    expect(screen.getByRole("status")).toHaveTextContent("Response stopped");
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
