type SpeechPhase = "idle" | "loading" | "playing" | "blocked" | "error";
type SpeechState = {
  owner: string | null;
  phase: SpeechPhase;
  error: string | null;
};
type AudioResult = { audio: Blob } | { error: string } | null;
type Reading = {
  owner: string;
  controller: AbortController;
  audio: HTMLAudioElement;
  url: string | null;
  finishPlayback?: (finished: boolean) => void;
  play?: () => void;
};

const IDLE: SpeechState = { owner: null, phase: "idle", error: null };
const GENERATION_ERROR =
  "Read aloud could not generate audio. Please try again.";
const PLAYBACK_ERROR =
  "Audio could not play. Check your browser’s audio settings and try again.";

/** Reads the rendered answer only, without Markdown syntax or source lists. */
export function renderedSpeechText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy
    .querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,pre,br")
    .forEach((block) => block.appendChild(document.createTextNode("\n")));
  return copy.textContent ?? "";
}

/** Keeps every character while favoring sentence boundaries and a quick first chunk. */
export function speechChunks(text: string): string[] {
  const characters = Array.from(
    text
      .replace(/\[[DW]\d+(?:\s*[,;]\s*[DW]\d+)*\]/g, "")
      .replace(/[\t ]+/g, " ")
      .replace(/ +([.,!?;:。，！？；：])/g, "$1")
      .replace(/ *\n */g, "\n")
      .trim(),
  );
  const chunks: string[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  while (offset < characters.length) {
    const limit = chunks.length === 0 ? 450 : 1_800;
    let end = offset;
    let bytes = 0;
    // A UTF-8 byte bound also keeps CJK and emoji safely within model tokens.
    while (end < characters.length && end - offset < limit) {
      const size = encoder.encode(characters[end]).length;
      if (bytes + size > 1_800) break;
      bytes += size;
      end++;
    }
    if (end < characters.length) {
      let wordBoundary = 0;
      const earliest = offset + Math.floor((end - offset) / 3);
      for (let cursor = end - 1; cursor >= earliest; cursor--) {
        const character = characters[cursor];
        if (
          /[。！？\n]/u.test(character) ||
          (/[.!?]/u.test(character) && /\s/u.test(characters[cursor + 1]))
        ) {
          end = cursor + 1;
          break;
        }
        if (!wordBoundary && /\s/u.test(character)) wordBoundary = cursor + 1;
        if (cursor === earliest && wordBoundary) end = wordBoundary;
      }
    }
    chunks.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}

function requestError(status: number) {
  if (status === 401)
    return "Your session expired. Refresh this page and try again.";
  if (status === 429) return "Read aloud is busy. Wait a moment and try again.";
  if (status === 503)
    return "Read aloud is unavailable. Check the agent service and try again.";
  if (status === 504) return "Read aloud took too long. Please try again.";
  return GENERATION_ERROR;
}

/** A shared player prevents overlapping answers and owns all temporary audio. */
export class ReadAloud {
  private state: SpeechState = IDLE;
  private active: Reading | null = null;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  getServerSnapshot = () => IDLE;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(
    owner: string | null,
    phase: SpeechPhase,
    error: string | null = null,
  ) {
    this.state = { owner, phase, error };
    this.listeners.forEach((listener) => listener());
  }

  stop = (owner?: string) => {
    if (owner && this.state.owner !== owner) return;
    const reading = this.active;
    this.active = null;
    if (reading) {
      reading.controller.abort();
      reading.finishPlayback?.(false);
      reading.audio.onended = null;
      reading.audio.onerror = null;
      reading.audio.pause();
      reading.audio.removeAttribute("src");
      reading.audio.load();
      if (reading.url) URL.revokeObjectURL(reading.url);
      reading.url = null;
    }
    this.update(null, "idle");
  };

  start = (owner: string, text: string) => {
    this.stop();
    const chunks = speechChunks(text);
    if (!chunks.length) {
      this.update(owner, "error", "There is no answer text to read aloud.");
      return;
    }
    try {
      const reading: Reading = {
        owner,
        controller: new AbortController(),
        audio: new Audio(),
        url: null,
      };
      this.active = reading;
      this.update(owner, "loading");
      void this.read(reading, chunks).catch(() =>
        this.fail(reading, PLAYBACK_ERROR),
      );
    } catch {
      this.update(owner, "error", PLAYBACK_ERROR);
    }
  };

  resume = (owner: string) => {
    if (this.active?.owner === owner && this.state.phase === "blocked")
      this.active.play?.();
  };

  private fail(reading: Reading, error: string) {
    if (this.active !== reading) return;
    this.stop();
    this.update(reading.owner, "error", error);
  }

  private async generate(reading: Reading, text: string): Promise<AudioResult> {
    const timeout = setTimeout(() => {
      this.fail(reading, "Read aloud took too long. Please try again.");
    }, 75_000);
    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: reading.controller.signal,
        cache: "no-store",
      });
      if (this.active !== reading) return null;
      if (!response.ok) return { error: requestError(response.status) };
      if (!response.headers.get("content-type")?.startsWith("audio/mpeg"))
        return { error: GENERATION_ERROR };
      const audio = await response.blob();
      if (this.active !== reading) return null;
      return audio.size ? { audio } : { error: GENERATION_ERROR };
    } catch {
      return this.active === reading ? { error: GENERATION_ERROR } : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async read(reading: Reading, chunks: string[]) {
    let next = this.generate(reading, chunks[0]);
    for (let index = 0; index < chunks.length; index++) {
      const result = await next;
      if (this.active !== reading || !result) return;
      if ("error" in result) {
        this.fail(reading, result.error);
        return;
      }
      const finished = await this.playChunk(reading, result.audio, () => {
        // Generate at most one next chunk, only after this one starts playing.
        if (index + 1 < chunks.length)
          next = this.generate(reading, chunks[index + 1]);
      });
      if (!finished || this.active !== reading) return;
      this.update(reading.owner, "loading");
    }
    if (this.active === reading) this.stop();
  }

  private playChunk(
    reading: Reading,
    audio: Blob,
    onPlaying: () => void,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let started = false;
      let attempting = false;
      let settled = false;
      const finish = (finished: boolean) => {
        settled = true;
        reading.audio.onended = null;
        reading.audio.onerror = null;
        reading.finishPlayback = undefined;
        reading.play = undefined;
        if (reading.url) URL.revokeObjectURL(reading.url);
        reading.url = null;
        resolve(finished);
      };
      reading.finishPlayback = finish;
      reading.audio.onended = () => finish(true);
      reading.audio.onerror = () => this.fail(reading, PLAYBACK_ERROR);
      reading.play = () => {
        if (this.active !== reading || attempting || settled) return;
        attempting = true;
        this.update(reading.owner, "loading");
        void reading.audio
          .play()
          .then(() => {
            attempting = false;
            if (this.active !== reading || settled) return;
            this.update(reading.owner, "playing");
            if (!started) {
              started = true;
              onPlaying();
            }
          })
          .catch((error: unknown) => {
            attempting = false;
            if (this.active !== reading || settled) return;
            if (
              (error instanceof Error || error instanceof DOMException) &&
              error.name === "NotAllowedError"
            )
              this.update(reading.owner, "blocked");
            else this.fail(reading, PLAYBACK_ERROR);
          });
      };
      try {
        reading.url = URL.createObjectURL(audio);
        reading.audio.src = reading.url;
        reading.play();
      } catch {
        this.fail(reading, PLAYBACK_ERROR);
      }
    });
  }
}

export const readAloud = new ReadAloud();
