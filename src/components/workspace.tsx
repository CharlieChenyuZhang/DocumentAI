"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CircleHelp,
  FileText,
  LoaderCircle,
  Menu,
  MessageSquare,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ApiError, askQuestion, uploadDocument, validatePdf } from "../lib/api";
import {
  conversationMarkdown,
  createConversation,
  EMPTY_CONVERSATION,
  formatSize,
  restoreConversations,
  STORAGE_KEY,
  type Conversation,
  type DocumentInfo,
  type Turn,
} from "../lib/workspace";
import { Composer } from "./composer";
import { AnswerCard } from "./answer-card";

const suggestions = [
  {
    title: "Summarize",
    prompt:
      "Summarize the key ideas in this document and highlight the most important takeaways.",
  },
  {
    title: "Key findings",
    prompt:
      "What are the most important findings, facts, and figures in this document?",
  },
  {
    title: "Explore context",
    prompt:
      "Explain the main topic of this document and compare it with relevant information from the web.",
  },
];

export function Workspace() {
  const [conversations, setConversations] = useState<Conversation[]>([
    EMPTY_CONVERSATION,
  ]);
  const [activeId, setActiveId] = useState(EMPTY_CONVERSATION.id);
  const [hydrated, setHydrated] = useState(false);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "answering">(
    "idle",
  );
  const [notice, setNotice] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMap = useRef(new Map<string, File>());
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const documentDialog = useRef<HTMLDialogElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const clearDialog = useRef<HTMLDialogElement>(null);
  const scrollEnd = useRef<HTMLDivElement>(null);
  const conversation =
    conversations.find((item) => item.id === activeId) ?? conversations[0];
  const document = conversation.document;
  const hasFile = !!document && availableFiles.includes(document.id);
  const busy = phase !== "idle";
  const hasMessages = conversation.turns.length > 0;

  useEffect(() => {
    let restored: Conversation[] = [];
    try {
      restored = restoreConversations(sessionStorage.getItem(STORAGE_KEY));
    } catch {
      /* Continue in memory when browser storage is unavailable. */
    }
    if (restored.length) {
      // Browser-only history is intentionally restored after hydration.
      setConversations(restored);
      setActiveId(restored[0].id);
    }
    setHydrated(true);
    return () => controller.current?.abort();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      /* The current session still works if browser storage is unavailable. */
    }
  }, [conversations, hydrated]);

  useEffect(() => {
    const referencedIds = new Set(
      conversations.flatMap((item) =>
        item.document ? [item.document.id] : [],
      ),
    );
    for (const id of fileMap.current.keys()) {
      if (!referencedIds.has(id)) fileMap.current.delete(id);
    }
    setAvailableFiles((ids) =>
      ids.some((id) => !referencedIds.has(id))
        ? ids.filter((id) => referencedIds.has(id))
        : ids,
    );
  }, [conversations]);

  useEffect(() => {
    const file = document && fileMap.current.get(document.id);
    const url = file ? URL.createObjectURL(file) : null;
    // A preview URL follows the selected in-memory File and is revoked on change.
    setPreviewUrl(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [document, availableFiles]);

  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.turns]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const panel = sidebarRef.current;
    const previousFocus = window.document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (helpDialog.current?.open || clearDialog.current?.open) return;
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.document.addEventListener("keydown", onKeyDown);
    return () => {
      window.document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [sidebarOpen]);

  function chooseFile() {
    if (!busy) {
      documentDialog.current?.close();
      fileInput.current?.click();
    }
  }
  function updateConversation(
    id: string,
    change: (item: Conversation) => Conversation,
  ) {
    setConversations((items) =>
      items.map((item) => (item.id === id ? change(item) : item)),
    );
  }
  function switchConversation(id: string) {
    if (locked.current) return;
    setActiveId(id);
    setDraft("");
    setUploadError("");
    setNotice("");
    setSidebarOpen(false);
  }
  function newConversation() {
    if (locked.current) return;
    const next = createConversation(document);
    setConversations((items) =>
      [next, ...items.filter((item) => item.turns.length)].slice(0, 30),
    );
    setActiveId(next.id);
    setDraft("");
    setNotice("");
    setUploadError("");
    setSidebarOpen(false);
  }

  async function attachFile(file: File) {
    if (locked.current) return;
    const error = validatePdf(file);
    setUploadError(error ?? "");
    if (error) return;
    locked.current = true;
    setPhase("uploading");
    setUploadName(file.name);
    setNotice("");
    const request = new AbortController();
    controller.current = request;
    try {
      await uploadDocument(file, { signal: request.signal });
      const reattaching =
        document &&
        document.name === file.name &&
        document.size === file.size &&
        document.lastModified === file.lastModified;
      const info: DocumentInfo = {
        id: reattaching ? document.id : crypto.randomUUID(),
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      };
      fileMap.current.set(info.id, file);
      setAvailableFiles((ids) => [...new Set([...ids, info.id])]);
      if (hasMessages && !reattaching) {
        const next = createConversation(info);
        setConversations((items) => [next, ...items].slice(0, 30));
        setActiveId(next.id);
        setDraft("");
      } else {
        updateConversation(conversation.id, (item) => ({
          ...item,
          document: info,
        }));
      }
      setNotice(`${file.name} is ready. Ask your first question.`);
    } catch (error) {
      setUploadError(
        error instanceof Error
          ? error.message
          : "The upload failed. Please try again.",
      );
    } finally {
      locked.current = false;
      controller.current = null;
      setPhase("idle");
      setUploadName("");
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    if (event.dataTransfer.files.length !== 1) {
      setUploadError("Please upload one PDF at a time.");
      return;
    }
    void attachFile(event.dataTransfer.files[0]);
  }

  async function sendQuestion(question = draft, retryId?: string) {
    const cleanQuestion = question.trim();
    if (locked.current || !cleanQuestion || !document) return;
    const file = fileMap.current.get(document.id);
    if (!file) {
      setUploadError("Reattach this document to continue the conversation.");
      return;
    }
    locked.current = true;
    setPhase("answering");
    setNotice("");
    setUploadError("");
    if (!retryId) setDraft("");
    const chatId = conversation.id;
    const turn: Turn = {
      id: retryId ?? crypto.randomUUID(),
      question: cleanQuestion,
      documentName: document.name,
      status: "pending",
    };
    updateConversation(chatId, (item) => ({
      ...item,
      title: item.turns.length ? item.title : cleanQuestion.slice(0, 60),
      turns: retryId
        ? item.turns.map((previous) =>
            previous.id === retryId ? turn : previous,
          )
        : [...item.turns, turn],
    }));
    const request = new AbortController();
    controller.current = request;
    try {
      // The legacy backend has one active PDF, so reselect this chat's file before each question.
      await uploadDocument(file, { signal: request.signal });
      const answer = await askQuestion(cleanQuestion, {
        signal: request.signal,
      });
      updateConversation(chatId, (item) => ({
        ...item,
        turns: item.turns.map((previous) =>
          previous.id === turn.id
            ? { ...turn, ...answer, status: "complete" }
            : previous,
        ),
      }));
    } catch (error) {
      const stopped = error instanceof ApiError && error.code === "aborted";
      updateConversation(chatId, (item) => ({
        ...item,
        turns: item.turns.map((previous) =>
          previous.id === turn.id
            ? {
                ...turn,
                status: stopped ? "stopped" : "error",
                error: stopped
                  ? undefined
                  : error instanceof Error
                    ? error.message
                    : "Something went wrong. Please try again.",
              }
            : previous,
        ),
      }));
    } finally {
      locked.current = false;
      controller.current = null;
      setPhase("idle");
    }
  }

  function exportConversation() {
    const blob = new Blob([conversationMarkdown(conversation)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "document-ai-conversation.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Conversation exported as Markdown.");
  }

  function clearHistory() {
    const next = createConversation();
    fileMap.current.clear();
    setAvailableFiles([]);
    setConversations([next]);
    setActiveId(next.id);
    setDraft("");
    setUploadError("");
    setNotice("Local conversation history cleared.");
    clearDialog.current?.close();
    setSidebarOpen(false);
  }

  const uploadZone = (
    <button
      type="button"
      className={`upload-zone ${dragging ? "is-dragging" : ""}`}
      onClick={chooseFile}
      disabled={busy}
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {phase === "uploading" ? (
        <LoaderCircle className="animate-spin" size={22} />
      ) : (
        <Upload size={22} strokeWidth={1.6} />
      )}
      <span className="upload-zone-copy">
        <strong>
          {phase === "uploading" ? "Uploading your document…" : "Upload a PDF"}
        </strong>
        <span>
          {phase === "uploading" ? uploadName : "Choose a file or drag it here"}
        </span>
      </span>
      <span className="file-requirement">Up to 20 MB</span>
    </button>
  );

  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">
        Skip to conversation
      </a>
      <input
        ref={fileInput}
        data-testid="pdf-input"
        type="file"
        accept=".pdf,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload PDF document"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void attachFile(file);
        }}
      />
      {sidebarOpen && (
        <button
          className="mobile-backdrop"
          aria-label="Dismiss navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}
        aria-label="Workspace navigation"
        role={sidebarOpen ? "dialog" : undefined}
        aria-modal={sidebarOpen || undefined}
      >
        <div className="sidebar-header">
          <div className="brand">
            <FileText size={23} strokeWidth={1.7} />
            <span>Document AI</span>
          </div>
          <button
            className="icon-button sidebar-close"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="new-chat-button"
          onClick={newConversation}
          disabled={busy}
        >
          <Plus size={17} />
          New conversation
        </button>
        <h2 className="history-heading">Recent chats</h2>
        <nav className="history-list" aria-label="Conversation history">
          {conversations.some((item) => item.turns.length) ? (
            conversations
              .filter((item) => item.turns.length)
              .map((item) => (
                <button
                  key={item.id}
                  title={item.title}
                  className={`history-item ${item.id === conversation.id ? "history-active" : ""}`}
                  aria-current={
                    item.id === conversation.id ? "page" : undefined
                  }
                  disabled={busy}
                  onClick={() => switchConversation(item.id)}
                >
                  <MessageSquare size={15} />
                  <span>{item.title}</span>
                </button>
              ))
          ) : (
            <p className="history-empty">
              Your conversations will appear here.
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="sidebar-utility"
            onClick={() => helpDialog.current?.showModal()}
          >
            <CircleHelp size={16} />
            Getting started
          </button>
          <button
            className="sidebar-utility"
            onClick={() => clearDialog.current?.showModal()}
            disabled={
              busy ||
              !conversations.some((item) => item.turns.length || item.document)
            }
          >
            <Trash2 size={15} />
            Clear local history
          </button>
          <p className="storage-note">History is saved in this browser tab.</p>
        </div>
      </aside>
      <div className="workspace-main" inert={sidebarOpen}>
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span title={conversation.title}>{conversation.title}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="header-button"
              aria-label="Show document"
              onClick={() => documentDialog.current?.showModal()}
            >
              <FileText size={16} />
              <span>Document</span>
              {document && <span className="document-count">1</span>}
            </button>
            <button
              className="header-button"
              aria-label="Export chat"
              onClick={exportConversation}
              disabled={!hasMessages || busy}
            >
              <ArrowDownToLine size={16} />
              <span>Export chat</span>
            </button>
          </div>
        </header>
        <main id="main-content" className="conversation-panel">
          <section
            className={`conversation-scroll ${hasMessages ? "has-messages" : ""}`}
            aria-label="Conversation"
          >
            {hasMessages ? (
              <div className="transcript">
                <h1 className="sr-only">{conversation.title}</h1>
                {conversation.turns.map((turn) => (
                  <AnswerCard
                    key={turn.id}
                    turn={turn}
                    retryDisabled={busy || !hasFile}
                    onRetry={() => void sendQuestion(turn.question, turn.id)}
                  />
                ))}
                <div ref={scrollEnd} />
              </div>
            ) : (
              <div className="welcome-content">
                <h1>Ask your document</h1>
                <p className="welcome-description">
                  Upload a PDF to get summaries, find answers, and explore
                  related information.
                </p>
                {hasFile && phase !== "uploading" ? (
                  <div className="ready-document">
                    <FileText size={22} strokeWidth={1.6} />
                    <div>
                      <strong>{document?.name}</strong>
                      <span>
                        <Check size={13} />
                        Ready for questions
                      </span>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="Replace document"
                      title="Replace document"
                      onClick={chooseFile}
                      disabled={busy}
                    >
                      <Upload size={17} />
                    </button>
                  </div>
                ) : (
                  uploadZone
                )}
                <div className="suggestions" aria-label="Suggested questions">
                  {suggestions.map(({ title, prompt }) => (
                    <button
                      key={title}
                      onClick={() => {
                        setDraft(prompt);
                        window.document
                          .querySelector<HTMLTextAreaElement>("textarea")
                          ?.focus();
                      }}
                    >
                      {title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
          <div className="composer-area">
            {uploadError && (
              <div className="inline-alert" role="alert">
                <CircleHelp size={16} />
                <span>{uploadError}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setUploadError("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {document && !hasFile && (
              <div className="reattach-notice">
                <FileText size={15} />
                <span>
                  Reattach <strong>{document.name}</strong> to ask more
                  questions.
                </span>
                <button onClick={chooseFile} disabled={busy}>
                  Browse files
                </button>
              </div>
            )}
            {phase === "uploading" && hasMessages && (
              <p className="upload-progress" role="status">
                <LoaderCircle className="animate-spin" size={15} />
                Uploading {uploadName}…
              </p>
            )}
            <span className="sr-only" role="status">
              {notice}
            </span>
            <Composer
              key={conversation.id}
              value={draft}
              onChange={setDraft}
              onSubmit={() => void sendQuestion()}
              onStop={() => controller.current?.abort()}
              disabled={phase === "uploading"}
              busy={phase === "answering"}
              hasDocument={hasFile}
              onUpload={chooseFile}
            />
          </div>
        </main>
      </div>
      <dialog
        ref={documentDialog}
        aria-labelledby="document-panel-title"
        className="document-dialog"
        onClick={(event) => {
          if (event.target === event.currentTarget)
            documentDialog.current?.close();
        }}
      >
        <div className="document-dialog-content">
          <div className="document-panel-header">
            <h2 id="document-panel-title">Document</h2>
            <button
              className="icon-button"
              aria-label="Close document"
              onClick={() => documentDialog.current?.close()}
            >
              <X size={20} />
            </button>
          </div>
          {document ? (
            <div className="document-details">
              <FileText size={25} strokeWidth={1.6} />
              <h3>{document.name}</h3>
              <p className="meta-text">PDF · {formatSize(document.size)}</p>
              <p className={`document-status ${hasFile ? "" : "needs-file"}`}>
                {hasFile ? <Check size={14} /> : <Upload size={14} />}
                {hasFile ? "Ready for questions" : "Reattach to continue"}
              </p>
              <div className="document-actions">
                {previewUrl && (
                  <a
                    className="secondary-button"
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open PDF
                    <ArrowUpRight size={15} />
                  </a>
                )}
                <button
                  className="secondary-button"
                  onClick={chooseFile}
                  disabled={busy}
                >
                  <Upload size={15} />
                  {hasFile ? "Replace document" : "Reattach document"}
                </button>
              </div>
            </div>
          ) : (
            <div className="document-details">
              <p className="empty-source">No document attached.</p>
              <button
                className="primary-button"
                onClick={chooseFile}
                disabled={busy}
              >
                <Plus size={16} />
                Add a document
              </button>
            </div>
          )}
          <p className="source-hint">
            One PDF per conversation. Uploading a different document starts a
            new chat.
          </p>
        </div>
      </dialog>
      <dialog
        ref={helpDialog}
        aria-labelledby="help-title"
        className="workspace-dialog"
        onClick={(event) => {
          if (event.target === event.currentTarget) helpDialog.current?.close();
        }}
      >
        <button
          className="dialog-close icon-button"
          aria-label="Close getting started"
          onClick={() => helpDialog.current?.close()}
        >
          <X size={20} />
        </button>
        <h2 id="help-title">Getting started</h2>
        <ol className="help-steps">
          <li>
            <strong>Upload a PDF</strong>
            <p>Choose one document, up to 20 MB.</p>
          </li>
          <li>
            <strong>Ask a question</strong>
            <p>
              Read the document answer and web answer. Each question is
              independent, so include the context you need.
            </p>
          </li>
          <li>
            <strong>Keep your answers</strong>
            <p>
              Copy a response or export the chat. History stays in this browser
              tab; reattach your PDF after a refresh.
            </p>
          </li>
        </ol>
        <button
          className="primary-button"
          onClick={() => helpDialog.current?.close()}
        >
          Got it
        </button>
      </dialog>
      <dialog
        ref={clearDialog}
        aria-labelledby="clear-title"
        className="workspace-dialog"
      >
        <h2 id="clear-title">Clear your local history?</h2>
        <p>
          This removes conversations and attached files from this browser tab.
          It does not delete files from the server.
        </p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            onClick={() => clearDialog.current?.close()}
          >
            Keep history
          </button>
          <button className="primary-button" onClick={clearHistory}>
            Clear history
          </button>
        </div>
      </dialog>
    </div>
  );
}
