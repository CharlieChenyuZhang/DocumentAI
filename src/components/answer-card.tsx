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
  Play,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./answer-card.css";
import { phaseLabel, type Turn } from "../lib/workspace";
import { readAloud, renderedSpeechText } from "../lib/read-aloud";

export type AnswerTurn = Turn;

interface AnswerCardProps {
  turn: AnswerTurn;
  onRetry: () => void;
  retryDisabled: boolean;
}

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

function isSafeWebSource(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function webSearchDetail(turn: AnswerTurn): string | undefined {
  if (turn.webSearchStatus === "disabled" || turn.searchMode === "documents") {
    return "Web search was off for this answer.";
  }
  switch (turn.webSearchStatus) {
    case "pending":
      return turn.status === "pending"
        ? "Web search is pending."
        : "Web search did not finish.";
    case "searching":
      return turn.status === "pending"
        ? "Searching the web…"
        : "Web search did not finish.";
    case "failed":
      return "Web search was unavailable. No web sources were added.";
    case "empty":
      return "Web search returned no results. No web sources were added.";
    case "skipped":
      if (turn.webSearchReason === "no_public_query") {
        return "Web search was skipped because no safe public query was available. Add a public topic to your question to search the web.";
      }
      if (turn.webSearchReason === "planning_unavailable") {
        return "Web search was skipped because search planning was unavailable.";
      }
      return turn.webSearchReason === "not_needed"
        ? "Web search was not needed for this question."
        : "Web search was skipped. No web sources were added.";
    case "complete":
      return "No web sources are available for this answer.";
    default:
      return turn.searchMode === "hybrid"
        ? "Documents + web were requested. No web results are recorded for this answer."
        : undefined;
  }
}

export function AnswerCard({ turn, onRetry, retryDisabled }: AnswerCardProps) {
  const headingId = useId();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const speech = useSyncExternalStore(
    readAloud.subscribe,
    readAloud.getSnapshot,
    readAloud.getServerSnapshot,
  );
  const ownSpeech = speech.owner === headingId ? speech : null;
  const isReading = Boolean(ownSpeech && ownSpeech.phase !== "error");
  const bodyRef = useRef<HTMLElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerText = turn.answer ?? "";
  const documentSources = (turn.citations ?? []).filter(
    (source) =>
      source.document_id.trim() &&
      source.document_name.trim() &&
      Number.isInteger(source.page) &&
      source.page > 0,
  );
  const webSources = (turn.webSources ?? []).filter((source) =>
    isSafeWebSource(source.url),
  );
  const hasHybridSources = documentSources.length > 0 && webSources.length > 0;
  const searchLabel = hasHybridSources
    ? "Hybrid search"
    : webSources.length
      ? "Web sources"
      : documentSources.length
        ? "Document sources"
        : undefined;
  const searchDetail = webSources.length
    ? hasHybridSources
      ? "Documents + web"
      : "No document sources were retrieved."
    : webSearchDetail(turn);
  const warnings = (turn.warnings ?? []).filter((warning) => {
    if (webSources.length || turn.searchMode === "documents") return true;
    if (
      turn.webSearchStatus === "failed" &&
      warning === "Web search was unavailable. No web results were used."
    ) {
      return false;
    }
    return !(
      turn.webSearchStatus === "skipped" &&
      turn.webSearchReason === "planning_unavailable" &&
      warning ===
        "Search planning was unavailable. The answer uses selected documents only."
    );
  });

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return () => readAloud.stop(headingId);
  }, [headingId, turn.id, turn.status, answerText]);

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
    if (isReading) {
      readAloud.stop(headingId);
      return;
    }
    readAloud.start(
      headingId,
      bodyRef.current ? renderedSpeechText(bodyRef.current) : answerText,
    );
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

        {(searchLabel || searchDetail || warnings.length > 0) && (
          <div className="answer-search-summary" aria-label="Search results">
            {(searchLabel || searchDetail) && (
              <p>
                {searchLabel && <strong>{searchLabel}</strong>}
                {searchDetail && <span>{searchDetail}</span>}
              </p>
            )}
            {warnings.map((warning) => (
              <p className="answer-search-warning" key={warning}>
                {warning}
              </p>
            ))}
          </div>
        )}

        {turn.status === "pending" && (
          <div className="answer-waiting" role="status">
            <span className="answer-waiting-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <p>{phaseLabel(turn.phase)}</p>
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

        {(turn.status === "complete" || Boolean(turn.answer)) && (
          <>
            <div className="answer-body">
              <section
                aria-label="Answer"
                className="answer-markdown"
                ref={bodyRef}
              >
                <SafeMarkdown>
                  {turn.answer || "No answer was returned."}
                </SafeMarkdown>
              </section>
              {(documentSources.length > 0 || webSources.length > 0) && (
                <div className="answer-sources" aria-label="Answer sources">
                  {documentSources.length > 0 && (
                    <details className="answer-citations">
                      <summary>
                        Document sources ({documentSources.length})
                      </summary>
                      <ul aria-label="Document sources">
                        {documentSources.map((source, index) => (
                          <li
                            key={`${source.document_id}:${source.page}:${index}`}
                          >
                            <FileText size={13} aria-hidden="true" />
                            <a
                              href={`/api/documents/${encodeURIComponent(source.document_id)}#page=${source.page}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {source.id ? `[${source.id}] ` : ""}
                              {source.document_name}, page {source.page}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {webSources.length > 0 && (
                    <details className="answer-citations" open>
                      <summary>Web sources ({webSources.length})</summary>
                      <ul aria-label="Web sources">
                        {webSources.map((source, index) => (
                          <li key={`${source.url}:${index}`}>
                            <Globe2 size={13} aria-hidden="true" />
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {source.id ? `[${source.id}] ` : ""}
                              {source.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
            {answerText && turn.status !== "pending" && (
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
                <button
                  className="answer-action"
                  type="button"
                  onClick={toggleReading}
                  aria-pressed={isReading}
                  aria-label={
                    isReading ? "Stop reading answer" : "Read answer aloud"
                  }
                  title="Read this answer with an AI-generated OpenAI voice"
                >
                  {isReading ? (
                    <Square size={13} aria-hidden="true" />
                  ) : (
                    <Volume2 size={15} aria-hidden="true" />
                  )}
                  {isReading ? "Stop reading" : "Read aloud"}
                </button>
                {ownSpeech?.phase === "blocked" && (
                  <button
                    className="answer-action"
                    type="button"
                    onClick={() => readAloud.resume(headingId)}
                  >
                    <Play size={14} aria-hidden="true" /> Play audio
                  </button>
                )}
                {isReading && (
                  <span
                    className="answer-action-feedback answer-voice-label"
                    role="status"
                  >
                    {ownSpeech?.phase === "loading"
                      ? "Preparing OpenAI AI voice…"
                      : ownSpeech?.phase === "blocked"
                        ? "OpenAI AI voice ready. Select Play audio to listen."
                        : "OpenAI AI voice"}
                  </span>
                )}
                {ownSpeech?.error && (
                  <span
                    className="answer-action-feedback answer-voice-error"
                    role="alert"
                  >
                    {ownSpeech.error}
                  </span>
                )}
                <span className="answer-action-feedback" role="status">
                  {copyState === "error"
                    ? "Couldn’t copy. Please select and copy the answer."
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
