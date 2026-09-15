import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadAloud, renderedSpeechText, speechChunks } from "./read-aloud";

class MockAudio {
  static instances: MockAudio[] = [];
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor() {
    MockAudio.instances.push(this);
  }
}

function audioResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "audio/mpeg" }),
    blob: vi
      .fn()
      .mockResolvedValue(new Blob(["test audio"], { type: "audio/mpeg" })),
  } as unknown as Response;
}

const NativeURL = URL;
let player: ReadAloud;
let fetchAudio: ReturnType<typeof vi.fn>;
let createURL: ReturnType<typeof vi.fn<(object: Blob | MediaSource) => string>>;
let revokeURL: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(() => {
  player = new ReadAloud();
  MockAudio.instances = [];
  vi.stubGlobal("Audio", MockAudio);
  fetchAudio = vi.fn().mockImplementation(async () => audioResponse());
  vi.stubGlobal("fetch", fetchAudio);
  createURL = vi
    .fn<(object: Blob | MediaSource) => string>()
    .mockImplementation(() => `blob:audio-${createURL.mock.calls.length}`);
  revokeURL = vi.fn<(url: string) => void>();
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = (object: Blob | MediaSource): string =>
        createURL(object);
      static revokeObjectURL = (url: string): void => {
        revokeURL(url);
      };
    },
  );
});

afterEach(() => {
  player.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("speech text", () => {
  it("narrates rendered formatting and link labels without source markers", () => {
    const element = document.createElement("section");
    element.innerHTML =
      '<h2>Findings</h2><p>The <strong>answer</strong> is useful [D1][W2].</p><ul><li>One</li><li><a href="https://example.com">More context</a></li></ul>';
    expect(speechChunks(renderedSpeechText(element)).join("")).toBe(
      "Findings\nThe answer is useful.\nOne\nMore context",
    );
  });

  it("preserves the full long multilingual answer in bounded sentence chunks", () => {
    const text =
      "中文回答很自然。😀 " +
      "A complete sentence with context. ".repeat(180) +
      "最后一句。";
    const chunks = speechChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 1800),
    ).toBe(true);
    expect(Array.from(chunks[0]).length).toBeLessThanOrEqual(450);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 1800)).toBe(
      true,
    );
    expect(chunks[0].trim()).toMatch(/[。.?!]$/);
    expect(chunks.join("")).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("splits oversized unbroken text without losing characters", () => {
    const text = "😀".repeat(6100);
    const chunks = speechChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 1800),
    ).toBe(true);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 1800)).toBe(
      true,
    );
  });
});

describe("ReadAloud", () => {
  it("waits for a click, then plays the complete answer with at most one chunk prefetched", async () => {
    expect(fetchAudio).not.toHaveBeenCalled();
    const text = "Every sentence should be narrated fully. ".repeat(130).trim();
    const chunks = speechChunks(text);
    player.start("answer-1", text);
    expect(player.getSnapshot()).toMatchObject({
      owner: "answer-1",
      phase: "loading",
    });
    const audio = MockAudio.instances[0];
    for (let index = 0; index < chunks.length; index++) {
      await vi.waitFor(() =>
        expect(audio.play).toHaveBeenCalledTimes(index + 1),
      );
      await vi.waitFor(() =>
        expect(player.getSnapshot().phase).toBe("playing"),
      );
      expect(fetchAudio).toHaveBeenCalledTimes(
        Math.min(index + 2, chunks.length),
      );
      expect(audio.onended).not.toBeNull();
      audio.onended?.();
    }
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("idle"));
    expect(
      fetchAudio.mock.calls
        .map((call) => JSON.parse(call[1].body).text)
        .join(""),
    ).toBe(text);
    expect(
      fetchAudio.mock.calls.every((call) => call[0] === "/api/speech"),
    ).toBe(true);
    expect(createURL).toHaveBeenCalledTimes(chunks.length);
    expect(revokeURL).toHaveBeenCalledTimes(chunks.length);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
  });

  it("cancels pending audio and ignores a late response", async () => {
    let resolve!: (response: Response) => void;
    fetchAudio.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    player.start("answer-1", "A pending answer.");
    const signal = fetchAudio.mock.calls[0][1].signal as AbortSignal;
    player.stop("answer-1");
    resolve(audioResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(player.getSnapshot().phase).toBe("idle");
    expect(createURL).not.toHaveBeenCalled();
    expect(MockAudio.instances[0].play).not.toHaveBeenCalled();
  });

  it("stops the previous answer and does not let its unmount cancel the next answer", async () => {
    player.start("answer-1", "First answer.");
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("playing"));
    const first = MockAudio.instances[0];
    const firstSignal = fetchAudio.mock.calls[0][1].signal as AbortSignal;
    player.start("answer-2", "Second answer.");
    player.stop("answer-1");
    await vi.waitFor(() =>
      expect(player.getSnapshot()).toMatchObject({
        owner: "answer-2",
        phase: "playing",
      }),
    );
    expect(first.pause).toHaveBeenCalledOnce();
    expect(firstSignal.aborted).toBe(true);
    expect(first.onended).toBeNull();
    expect(revokeURL).toHaveBeenCalledWith("blob:audio-1");
  });

  it("cancels the one prefetched request and releases current playback", async () => {
    let resolve!: (response: Response) => void;
    fetchAudio.mockResolvedValueOnce(audioResponse()).mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    player.start("answer-1", "A long answer sentence. ".repeat(200));
    await vi.waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));
    const audio = MockAudio.instances[0];
    const signal = fetchAudio.mock.calls[1][1].signal as AbortSignal;
    player.stop("answer-1");
    resolve(audioResponse());
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(revokeURL).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.onerror).toBeNull();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(player.getSnapshot().phase).toBe("idle");
  });

  it("requires an explicit play action when the browser blocks audio", async () => {
    player.start("answer-1", "A long answer sentence. ".repeat(100));
    const audio = MockAudio.instances[0];
    audio.play.mockRejectedValueOnce(
      new DOMException("Autoplay blocked", "NotAllowedError"),
    );
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("blocked"));
    expect(fetchAudio).toHaveBeenCalledOnce();
    player.resume("answer-1");
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("playing"));
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    expect(createURL).toHaveBeenCalledOnce();
  });

  it.each([401, 429, 503, 504, 500])(
    "shows a safe actionable error for HTTP %s and allows retry",
    async (status) => {
      fetchAudio.mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => ({ error: "raw secret diagnostic" }),
      });
      player.start("answer-1", "Read the answer.");
      await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("error"));
      expect(player.getSnapshot().error).toMatch(/try again/i);
      expect(player.getSnapshot().error).not.toContain("secret");
      expect(MockAudio.instances[0].play).not.toHaveBeenCalled();
      player.start("answer-1", "Read the answer.");
      await vi.waitFor(() =>
        expect(player.getSnapshot().phase).toBe("playing"),
      );
    },
  );

  it("releases audio after playback failure", async () => {
    player.start("answer-1", "Read the answer.");
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("playing"));
    MockAudio.instances[0].onerror?.();
    expect(player.getSnapshot()).toMatchObject({
      owner: "answer-1",
      phase: "error",
    });
    expect(player.getSnapshot().error).toContain("Audio could not play");
    expect(revokeURL).toHaveBeenCalledOnce();
  });

  it("times out a stalled request without leaving it running", async () => {
    vi.useFakeTimers();
    fetchAudio.mockReturnValue(new Promise(() => {}));
    player.start("answer-1", "Read the answer.");
    const signal = fetchAudio.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(75_000);
    expect(signal.aborted).toBe(true);
    expect(player.getSnapshot().error).toContain("took too long");
  });

  it("rejects empty or non-audio successful responses", async () => {
    fetchAudio.mockResolvedValueOnce({
      ...audioResponse(),
      headers: new Headers({ "Content-Type": "application/json" }),
    });
    player.start("answer-1", "Read the answer.");
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("error"));
    fetchAudio.mockResolvedValueOnce({
      ...audioResponse(),
      blob: async () => new Blob(),
    });
    player.start("answer-1", "Read the answer.");
    await vi.waitFor(() => expect(player.getSnapshot().phase).toBe("error"));
    expect(createURL).not.toHaveBeenCalled();
  });
});
