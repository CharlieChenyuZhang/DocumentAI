"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Globe2, Mic, Paperclip, Square, X } from "lucide-react";
import { supportsVoiceInput, VoiceInput } from "../lib/voice-input";
import "./composer.css";

const subscribeToSpeechSupport = () => () => {};
const serverSpeechSupport = () => false;

export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  disabled: boolean;
  busy: boolean;
  hasDocument: boolean;
  onUpload: () => void;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
  busy,
  hasDocument,
  onUpload,
}: ComposerProps) {
  const speechSupported = useSyncExternalStore(
    subscribeToSpeechSupport,
    supportsVoiceInput,
    serverSpeechSupport,
  );
  const [voice] = useState(() => new VoiceInput());
  const { phase, error: speechError } = useSyncExternalStore(
    voice.subscribe,
    voice.getSnapshot,
    voice.getSnapshot,
  );
  const listening = phase === "recording";
  const voiceActive = phase !== "idle";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const hintId = useId();
  const actionsDisabled = disabled || busy;
  const canSubmit =
    !actionsDisabled && !voiceActive && hasDocument && value.trim().length > 0;

  useEffect(() => () => voice.cancel(), [voice]);

  useEffect(() => {
    voice.cancel();
  }, [value, voice]);

  useEffect(() => {
    if (actionsDisabled) voice.cancel();
  }, [actionsDisabled, voice]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [value]);

  function toggleRecording() {
    if (listening) {
      voice.finish();
    } else if (voiceActive) {
      voice.cancel();
    } else if (!actionsDisabled) {
      const baseDraft = value.trimEnd();
      void voice.start((text) => {
        onChange(`${baseDraft}${baseDraft ? " " : ""}${text}`);
        textareaRef.current?.focus();
      });
    }
  }

  const voiceLabel = listening
    ? "Stop voice input"
    : phase === "requesting"
      ? "Cancel voice input"
      : phase === "transcribing"
        ? "Cancel transcription"
        : "Start voice input";

  function submit() {
    if (!canSubmit) return;
    voice.cancel();
    onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    submit();
  }

  return (
    <div className="doc-composer-wrap">
      <form
        className={`doc-composer${listening ? " doc-composer-listening" : ""}`}
        aria-label="Ask Document AI"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          className="doc-composer-input"
          aria-label="Your question"
          aria-describedby={hintId}
          placeholder={
            hasDocument
              ? "Ask about your selected documents..."
              : "Select PDFs to get started"
          }
          value={value}
          rows={2}
          onChange={(event) => {
            voice.cancel();
            onChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
        <div className="doc-composer-toolbar">
          <div className="doc-composer-tools">
            <button
              className="doc-composer-icon"
              type="button"
              aria-label="Attach a PDF"
              title="Attach a PDF"
              disabled={actionsDisabled}
              onClick={() => {
                voice.cancel();
                onUpload();
              }}
            >
              <Paperclip size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
            <span
              className="doc-composer-source"
              title="Answers use your selected sources"
            >
              <Globe2 size={13} strokeWidth={1.7} aria-hidden="true" />
              Selected sources
            </span>
          </div>
          <div className="doc-composer-tools">
            {speechSupported && (
              <button
                className={`doc-composer-icon${listening ? " doc-composer-mic-active" : ""}`}
                type="button"
                aria-label={voiceLabel}
                aria-pressed={voiceActive}
                title={
                  voiceActive
                    ? voiceLabel
                    : "Dictate your question using OpenAI"
                }
                disabled={actionsDisabled}
                onClick={toggleRecording}
              >
                {listening ? (
                  <Square size={14} fill="currentColor" aria-hidden="true" />
                ) : voiceActive ? (
                  <X size={18} aria-hidden="true" />
                ) : (
                  <Mic size={18} strokeWidth={1.7} aria-hidden="true" />
                )}
              </button>
            )}
            {busy ? (
              <button
                type="button"
                className="doc-composer-send"
                aria-label="Stop generating"
                title="Stop generating"
                onClick={onStop}
              >
                <Square size={13} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="doc-composer-send"
                aria-label="Send question"
                title="Send question"
                disabled={!canSubmit}
              >
                <ArrowUp size={20} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
      <div className="doc-composer-caption" id={hintId}>
        <span role="status">
          {listening
            ? "Recording. Click stop to transcribe with OpenAI. Up to 2 minutes."
            : phase === "requesting"
              ? "Allow microphone access to start recording."
              : phase === "transcribing"
                ? "Transcribing with OpenAI. Your question will be ready to review."
                : "Enter to send · Shift + Enter for a new line"}
        </span>
      </div>
      {speechError && (
        <div className="doc-composer-error" role="alert">
          <span>{speechError}</span>
          <button
            type="button"
            className="doc-composer-icon"
            aria-label="Dismiss voice input error"
            onClick={voice.dismissError}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
