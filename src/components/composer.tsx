"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Globe2, Mic, Paperclip, Square, X } from "lucide-react";
import "./composer.css";

type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type SpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
};

const subscribeToSpeechSupport = () => () => {};
const serverSpeechSupport = () => false;
const browserSpeechSupport = () => {
  const speechWindow = window as SpeechWindow;
  return Boolean(
    speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition,
  );
};

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

function releaseRecognition(recognition: SpeechRecognition | null) {
  if (!recognition) return;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  try {
    recognition.abort();
  } catch {
    // Some browsers throw when a recognition session has already ended.
  }
}

function speechErrorMessage(error: string) {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone access was denied. Allow access in your browser, or type your question.";
  }
  if (error === "audio-capture")
    return "No microphone was found. You can still type your question.";
  if (error === "no-speech")
    return "No speech detected. Try again or type your question.";
  if (error === "network")
    return "Voice input could not connect. Try again or type your question.";
  return "Voice input is unavailable right now. You can still type your question.";
}

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
    browserSpeechSupport,
    serverSpeechSupport,
  );
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const changeRef = useRef(onChange);
  const hintId = useId();
  const actionsDisabled = disabled || busy;
  const canSubmit = !actionsDisabled && hasDocument && value.trim().length > 0;

  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    return () => {
      releaseRecognition(recognitionRef.current);
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [value]);

  const stopRecording = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    releaseRecognition(recognition);
    setListening(false);
  }, []);

  useEffect(() => {
    if (actionsDisabled && recognitionRef.current) {
      // The browser's end/error event updates recording state after aborting.
      const recognition = recognitionRef.current;
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        recognition.onend?.();
      }
    }
  }, [actionsDisabled]);

  function toggleRecording() {
    if (recognitionRef.current) {
      stopRecording();
      return;
    }
    if (actionsDisabled) return;
    const speechWindow = window as SpeechWindow;
    const Recognition =
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;

    setSpeechError(null);
    const baseDraft = value.trimEnd();
    let recognition: SpeechRecognition;
    try {
      recognition = new Recognition();
      recognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        if (recognitionRef.current !== recognition) return;
        const transcript = Array.from(
          event.results,
          (result) => result[0]?.transcript || "",
        )
          .join(" ")
          .trim();
        if (transcript)
          changeRef.current(`${baseDraft}${baseDraft ? " " : ""}${transcript}`);
      };
      recognition.onerror = (event) => {
        if (recognitionRef.current !== recognition) return;
        if (event.error !== "aborted")
          setSpeechError(speechErrorMessage(event.error));
        stopRecording();
      };
      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return;
        recognitionRef.current = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        setListening(false);
      };
      setListening(true);
      recognition.start();
    } catch {
      stopRecording();
      setSpeechError(
        "Voice input could not start. Check microphone access or type your question.",
      );
    }
  }

  function submit() {
    if (!canSubmit) return;
    stopRecording();
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
            stopRecording();
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
                stopRecording();
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
                aria-label={
                  listening ? "Stop voice input" : "Start voice input"
                }
                aria-pressed={listening}
                title={listening ? "Stop voice input" : "Dictate your question"}
                disabled={actionsDisabled}
                onClick={toggleRecording}
              >
                {listening ? (
                  <Square size={14} fill="currentColor" aria-hidden="true" />
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
            ? "Listening. Your words will appear above for review."
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
            onClick={() => setSpeechError(null)}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
