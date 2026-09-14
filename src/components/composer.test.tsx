import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./composer";

class MockSpeechRecognition {
  static latest: MockSpeechRecognition;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null =
    null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  abort = vi.fn(() => this.onend?.());
  constructor() {
    MockSpeechRecognition.latest = this;
  }
}

function harness(props: Partial<ComposerProps> = {}) {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  const onUpload = vi.fn();
  function Wrapper() {
    const [value, setValue] = useState(props.value ?? "");
    return (
      <Composer
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onStop={onStop}
        onUpload={onUpload}
        disabled={false}
        busy={false}
        hasDocument={true}
        {...props}
      />
    );
  }
  return { ...render(<Wrapper />), onSubmit, onStop, onUpload };
}

afterEach(() => vi.unstubAllGlobals());

describe("Composer", () => {
  it("sends with Enter but preserves Shift+Enter and IME composition", () => {
    const { onSubmit } = harness({ value: "Summarize this document" });
    const input = screen.getByRole("textbox", { name: "Your question" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps drafts editable without a document", () => {
    const { onSubmit } = harness({ hasDocument: false });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My draft" },
    });
    expect(screen.getByRole("textbox")).toHaveValue("My draft");
    expect(
      screen.getByRole("button", { name: "Send question" }),
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit whitespace-only questions", () => {
    const { onSubmit } = harness({ value: "   " });
    expect(
      screen.getByRole("button", { name: "Send question" }),
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("falls back to typing when speech recognition is unsupported", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    harness();
    expect(
      screen.queryByRole("button", { name: "Start voice input" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("updates an editable draft without submitting and stops recording on manual edits", () => {
    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
    const { onSubmit } = harness();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Explain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    const recognition = MockSpeechRecognition.latest;
    act(() =>
      recognition.onresult?.({
        results: [[{ transcript: "the main findings" }]],
      }),
    );
    expect(screen.getByRole("textbox")).toHaveValue(
      "Explain the main findings",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Explain the methods" },
    });
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(recognition.onresult).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start voice input" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("shows microphone permission errors and cleans up recording on unmount", () => {
    vi.stubGlobal("webkitSpeechRecognition", MockSpeechRecognition);
    const { unmount } = harness();
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    act(() => MockSpeechRecognition.latest.onerror?.({ error: "not-allowed" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access was denied",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    const recognition = MockSpeechRecognition.latest;
    unmount();
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(recognition.onresult).toBeNull();
    expect(recognition.onend).toBeNull();
  });

  it("stops dictation when busy and exposes the generation stop action", () => {
    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
    const props: ComposerProps = {
      value: "",
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onStop: vi.fn(),
      onUpload: vi.fn(),
      busy: false,
      disabled: false,
      hasDocument: true,
    };
    const { rerender } = render(<Composer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    const recognition = MockSpeechRecognition.latest;
    rerender(<Composer {...props} busy />);
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Attach a PDF" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Start voice input" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });
});
