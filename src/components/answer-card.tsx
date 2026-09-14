"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Check,
  Copy,
  FileText,
  Globe2,
  Leaf,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./answer-card.css";

export interface AnswerTurn {
  id: string;
  question: string;
  ragAnswer?: string;
  mcpAnswer?: string;
  status: "pending" | "complete" | "error" | "stopped";
  error?: string;
  documentName: string;
}

interface AnswerCardProps {
  turn: AnswerTurn;
  onRetry: () => void;
  retryDisabled: boolean;
}

const subscribeToSpeechSupport = () => () => {};
const getSpeechSupport = () =>
  typeof window !== "undefined" &&
  Boolean(window.speechSynthesis) &&
  typeof window.SpeechSynthesisUtterance === "function";
const getServerSpeechSupport = () => false;

function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          if (!href || !/^(https?:\/\/|mailto:)/i.test(href)) {
            return <span>{children}</span>;
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
        img: ({ alt }) => (
          <span className="answer-image-alt">
            [Image: {alt || "description unavailable"}]
          </span>
        ),
        table: ({ children }) => (
          <div
            className="answer-table-scroll"
            role="region"
            aria-label="Answer table"
            tabIndex={0}
          >
            <table>{children}</table>
          </div>
        ),
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function AnswerCard({ turn, onRetry, retryDisabled }: AnswerCardProps) {
  const headingId = useId();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const canSpeak = useSyncExternalStore(
    subscribeToSpeechSupport,
    getSpeechSupport,
    getServerSpeechSupport,
  );
  const [isReading, setIsReading] = useState(false);
  const [speechError, setSpeechError] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerText = [
    turn.ragAnswer ? `Document answer\n\n${turn.ragAnswer}` : "",
    turn.mcpAnswer ? `Web answer\n\n${turn.mcpAnswer}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (utteranceRef.current) {
        utteranceRef.current.onend = null;
        utteranceRef.current.onerror = null;
        utteranceRef.current = null;
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  async function copyAnswer() {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    try {
      await navigator.clipboard.writeText(answerText);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 3500);
  }

  function toggleReading() {
    setSpeechError(false);
    if (utteranceRef.current) {
      utteranceRef.current = null;
      window.speechSynthesis.cancel();
      setIsReading(false);
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(
        bodyRef.current?.innerText || answerText,
      );
      utteranceRef.current = utterance;
      utterance.onend = () => {
        if (utteranceRef.current === utterance) {
          utteranceRef.current = null;
          setIsReading(false);
        }
      };
      utterance.onerror = (event) => {
        if (utteranceRef.current === utterance) {
          utteranceRef.current = null;
          setIsReading(false);
          setSpeechError(
            event.error !== "canceled" && event.error !== "interrupted",
          );
        }
      };
      setIsReading(true);
      window.speechSynthesis.speak(utterance);
    } catch {
      utteranceRef.current = null;
      setIsReading(false);
      setSpeechError(true);
    }
  }

  return (
    <article className="answer-turn" aria-labelledby={headingId}>
      <div className="answer-question">
        <div className="answer-question-label">You</div>
        <h2 id={headingId}>{turn.question}</h2>
      </div>

      <div className="answer-response">
        <div className="answer-assistant-heading">
          <span className="answer-avatar" aria-hidden="true">
            <Leaf size={18} strokeWidth={1.7} />
          </span>
          <span className="answer-assistant-name">Document AI</span>
          <span className="answer-document-tag" title={turn.documentName}>
            <FileText size={12} aria-hidden="true" />
            <span>{turn.documentName}</span>
          </span>
        </div>

        {turn.status === "pending" && (
          <div className="answer-waiting" role="status">
            <span className="answer-waiting-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <p>Reading your document and searching the web</p>
          </div>
        )}

        {(turn.status === "error" || turn.status === "stopped") && (
          <div
            className={`answer-notice answer-notice-${turn.status}`}
            role={turn.status === "error" ? "alert" : "status"}
          >
            <p className="answer-notice-title">
              {turn.status === "error"
                ? "We couldn’t finish this answer"
                : "Response stopped"}
            </p>
            <p>
              {turn.status === "error"
                ? turn.error ||
                  "Something went wrong. Please try your question again."
                : "Your question is saved here. You can try again when you’re ready."}
            </p>
            <button
              className="answer-retry"
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
            >
              <RotateCcw size={14} aria-hidden="true" /> Try again
            </button>
          </div>
        )}

        {turn.status === "complete" && (
          <>
            <div className="answer-body" ref={bodyRef}>
              <section
                className="answer-source-section"
                aria-label="Document answer"
              >
                <h3 className="answer-source-title">
                  <FileText size={14} aria-hidden="true" /> Document answer
                </h3>
                <div className="answer-markdown">
                  {turn.ragAnswer ? (
                    <SafeMarkdown>{turn.ragAnswer}</SafeMarkdown>
                  ) : (
                    <p className="answer-empty">
                      No document answer was returned.
                    </p>
                  )}
                </div>
              </section>
              <section
                className="answer-source-section answer-web-section"
                aria-label="Web answer"
              >
                <h3 className="answer-source-title">
                  <Globe2 size={14} aria-hidden="true" /> Web answer
                </h3>
                <div className="answer-markdown">
                  {turn.mcpAnswer ? (
                    <SafeMarkdown>{turn.mcpAnswer}</SafeMarkdown>
                  ) : (
                    <p className="answer-empty">No web answer was returned.</p>
                  )}
                </div>
              </section>
            </div>
            {answerText && (
              <div className="answer-actions">
                <button
                  className="answer-action"
                  type="button"
                  onClick={copyAnswer}
                  aria-label={
                    copyState === "copied" ? "Answer copied" : "Copy answer"
                  }
                >
                  {copyState === "copied" ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Copy size={14} aria-hidden="true" />
                  )}
                  {copyState === "copied" ? "Copied" : "Copy"}
                </button>
                {canSpeak && (
                  <button
                    className="answer-action"
                    type="button"
                    onClick={toggleReading}
                    aria-pressed={isReading}
                    aria-label={
                      isReading ? "Stop reading answer" : "Read answer aloud"
                    }
                  >
                    {isReading ? (
                      <Square size={13} aria-hidden="true" />
                    ) : (
                      <Volume2 size={15} aria-hidden="true" />
                    )}
                    {isReading ? "Stop reading" : "Read aloud"}
                  </button>
                )}
                <span className="answer-action-feedback" role="status">
                  {copyState === "error"
                    ? "Couldn’t copy. Please select and copy the answer."
                    : speechError
                      ? "Read aloud is unavailable. Please try again."
                      : copyState === "copied"
                        ? "Answer copied to clipboard."
                        : ""}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}
