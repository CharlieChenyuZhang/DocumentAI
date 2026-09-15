import { ApiError, transcribeAudio } from "./api";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_MS = 120_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
type VoiceState = {
  phase: "idle" | "requesting" | "recording" | "transcribing";
  error: string | null;
};
type Recording = {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  chunks: Blob[];
  bytes: number;
  controller: AbortController;
  onTranscript: (text: string) => void;
};

export function supportsVoiceInput() {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    MIME_TYPES.some((type) => MediaRecorder.isTypeSupported(type))
  );
}

function microphoneError(error: unknown) {
  const name =
    error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow access in your browser and system settings, then try again.";
  if (name === "NotFoundError")
    return "No microphone was found. Connect a microphone or type your question.";
  if (name === "NotReadableError")
    return "Your microphone is unavailable. Close other apps using it, then try again.";
  return "Recording could not start. Check microphone access or type your question.";
}

function releaseMicrophone(recording: Recording) {
  recording.stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
}

/** Owns capture and upload together, so cancellation also rejects late results. */
export class VoiceInput {
  private state: VoiceState = { phase: "idle", error: null };
  private listeners = new Set<() => void>();
  private active: Recording | null = null;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(phase: VoiceState["phase"], error: string | null = null) {
    this.state = { phase, error };
    this.listeners.forEach((listener) => listener());
  }

  dismissError = () => this.update(this.state.phase);

  cancel = (error: string | null = null) => {
    const recording = this.active;
    this.active = null;
    if (recording) {
      clearTimeout(recording.timer);
      recording.controller.abort();
      const recorder = recording.recorder;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // A failed recorder must still release the microphone below.
        }
      }
      releaseMicrophone(recording);
      recording.chunks = [];
    }
    this.update("idle", error);
  };

  async start(onTranscript: (text: string) => void) {
    if (this.active) return;
    if (!supportsVoiceInput()) {
      this.update(
        "idle",
        "Voice input needs a browser with microphone access. Open this page in Chrome, Edge, or Safari, or type your question.",
      );
      return;
    }
    const recording: Recording = {
      chunks: [],
      bytes: 0,
      controller: new AbortController(),
      onTranscript,
    };
    this.active = recording;
    this.update("requesting");
    recording.timer = setTimeout(() => {
      if (this.active === recording)
        this.cancel(
          "Microphone access took too long. Allow access and try again.",
        );
    }, 30_000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recording.stream = stream;
      if (this.active !== recording) {
        releaseMicrophone(recording);
        return;
      }
      clearTimeout(recording.timer);
      const mimeType = MIME_TYPES.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 64_000,
      });
      recording.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.active !== recording || !event.data.size) return;
        recording.bytes += event.data.size;
        if (recording.bytes > MAX_AUDIO_BYTES) {
          this.cancel("This recording is too large. Try a shorter question.");
          return;
        }
        recording.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (this.active === recording)
          this.cancel(
            "Recording was interrupted. Check your microphone and try again.",
          );
      };
      recorder.onstop = () => {
        if (this.active === recording)
          void this.transcribe(recording, recorder.mimeType || mimeType!);
      };
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (this.active === recording)
            this.cancel(
              "Microphone access ended. Check your microphone and try again.",
            );
        };
      });
      recorder.start(1_000);
      this.update("recording");
      recording.timer = setTimeout(() => this.finish(), MAX_RECORDING_MS);
    } catch (error) {
      if (this.active === recording) this.cancel(microphoneError(error));
    }
  }

  finish = () => {
    const recording = this.active;
    if (!recording?.recorder || this.state.phase !== "recording") return;
    clearTimeout(recording.timer);
    this.update("transcribing");
    try {
      recording.recorder.stop();
      releaseMicrophone(recording);
    } catch {
      this.cancel("Recording could not finish. Please try again.");
    }
  };

  private async transcribe(recording: Recording, mimeType: string) {
    clearTimeout(recording.timer);
    releaseMicrophone(recording);
    this.update("transcribing");
    const audio = new Blob(recording.chunks, { type: mimeType });
    recording.chunks = [];
    if (!audio.size) {
      this.cancel("No audio was recorded. Speak for a moment and try again.");
      return;
    }
    try {
      const text = await transcribeAudio(audio, {
        signal: recording.controller.signal,
      });
      if (this.active !== recording) return;
      this.cancel(
        text ? null : "No speech detected. Try again or type your question.",
      );
      if (text) recording.onTranscript(text);
    } catch (error) {
      if (this.active !== recording) return;
      this.cancel(
        error instanceof ApiError
          ? error.message
          : "Voice transcription failed. Please try again.",
      );
    }
  }
}
