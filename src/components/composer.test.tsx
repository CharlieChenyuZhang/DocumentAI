import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./composer";

class MockMediaRecorder {
  static latest: MockMediaRecorder;
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["recorded audio"], { type: this.mimeType }),
    });
    this.onstop?.();
  });
  constructor() {
    MockMediaRecorder.latest = this;
  }
}

function audioSupport() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ text: "the main findings" }));
  vi.stubGlobal("fetch", fetch);
  return { getUserMedia, track, stream, fetch };
}

async function record() {
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await screen.findByRole("button", { name: "Stop voice input" });
  return MockMediaRecorder.latest;
}

function harness(props: Partial<ComposerProps> = {}) {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  const onUpload = vi.fn();
  function Wrapper() {
    const [value, setValue] = useState(props.value ?? "");
    return (
      <Composer
        {...props}
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onStop={onStop}
        onUpload={onUpload}
        disabled={props.disabled ?? false}
        busy={props.busy ?? false}
        hasDocument={props.hasDocument ?? true}
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

  it("keeps typing available when microphone recording is unsupported", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    harness();
    expect(
      screen.queryByRole("button", { name: "Start voice input" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("transcribes a recording into the existing editable draft without sending", async () => {
    const { fetch, track } = audioSupport();
    const { onSubmit } = harness({ value: "Explain" });
    await record();
    expect(
      screen.getByRole("button", { name: "Send question" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue(
        "Explain the main findings",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const [path, request] = fetch.mock.calls[0];
    expect(path).toBe("/api/transcriptions");
    expect(request.credentials).toBe("same-origin");
    expect(request.body.get("file").type).toBe("audio/webm;codecs=opus");
    expect(request.body.get("file").size).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
  });

  it("discards a recording when the draft is edited", async () => {
    const { fetch, track } = audioSupport();
    harness();
    const recorder = await record();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "A manual question" },
    });
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(recorder.onstop).toBeNull();
    expect(track.stop).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("A manual question");
  });

  it("aborts pending transcription and never overwrites a manual edit with a late response", async () => {
    const { fetch } = audioSupport();
    let resolve!: (response: Response) => void;
    fetch.mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    harness();
    await record();
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    await screen.findByRole("button", { name: "Cancel transcription" });
    const signal = fetch.mock.calls[0][1].signal;
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep my edit" },
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve(Response.json({ text: "late transcript" }));
    });
    expect(screen.getByRole("textbox")).toHaveValue("Keep my edit");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("handles denied microphone permission and allows a retry", async () => {
    const { getUserMedia, stream, track } = audioSupport();
    getUserMedia.mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    const { unmount } = harness();
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Microphone access was denied",
    );
    getUserMedia.mockResolvedValue(stream);
    const recorder = await record();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(recorder.onstop).toBeNull();
  });

  it("releases a microphone that arrives after permission was cancelled", async () => {
    const { getUserMedia, stream, track, fetch } = audioSupport();
    let resolve!: (value: typeof stream) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    harness();
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice input" }));
    await act(async () => {
      resolve(stream);
    });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Start voice input" }),
    ).toBeEnabled();
  });

  it("shows a recoverable no-speech result and sanitizes provider errors", async () => {
    const { fetch } = audioSupport();
    fetch.mockResolvedValueOnce(Response.json({ text: "  " }));
    harness({ value: "My draft" });
    await record();
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No speech detected",
    );
    fetch.mockResolvedValueOnce(
      Response.json({ error: "private upstream diagnostics" }, { status: 503 }),
    );
    await record();
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "temporarily unavailable",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("private upstream");
    expect(screen.getByRole("textbox")).toHaveValue("My draft");
  });

  it("cancels voice capture when busy and exposes the generation stop action", async () => {
    const { track, fetch } = audioSupport();
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
    await record();
    rerender(<Composer {...props} busy />);
    expect(track.stop).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Attach a PDF" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Start voice input" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });
});
