"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Globe2,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquare,
  PanelRightClose,
  Plus,
  Search,
  Sparkles,
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
    icon: BookOpen,
    title: "See the big picture",
    description: "A clear, concise summary",
    prompt:
      "Summarize the key ideas in this document and highlight the most important takeaways.",
  },
  {
    icon: Search,
    title: "Find the details",
    description: "Go straight to what matters",
    prompt:
      "What are the most important findings, facts, and figures in this document?",
  },
  {
    icon: Globe2,
    title: "Connect the dots",
    description: "Explore the wider context",
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
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [tab, setTab] = useState<"conversation" | "document">("conversation");
  const [availableFiles, setAvailableFiles] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMap = useRef(new Map<string, File>());
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const sourcesRef = useRef<HTMLElement>(null);
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
    if (!sidebarOpen && !sourcesOpen) return;
    const panel = sidebarOpen ? sidebarRef.current : sourcesRef.current;
    const previousFocus = window.document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        setSourcesOpen(false);
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
  }, [sidebarOpen, sourcesOpen]);

  function chooseFile() {
    if (!busy) {
      setSourcesOpen(false);
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
    setTab("conversation");
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
    setTab("conversation");
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
    setTab("conversation");
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

  const uploadZone = (compact = false) => (
    <button
      type="button"
      className={`upload-zone ${compact ? "upload-zone-compact" : ""} ${dragging ? "is-dragging" : ""}`}
      onClick={chooseFile}
      disabled={busy}
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <span className="upload-symbol">
        {phase === "uploading" ? (
          <LoaderCircle className="animate-spin" size={23} />
        ) : (
          <Upload size={23} strokeWidth={1.5} />
        )}
      </span>
      <span className="upload-zone-copy">
        <strong>
          {phase === "uploading"
            ? "Uploading your document…"
            : document
              ? "Upload a new document"
              : "Drop a document, discover more"}
        </strong>
        <span>
          {phase === "uploading" ? (
            uploadName
          ) : (
            <>
              Drag your PDF here or{" "}
              <span className="upload-browse">
                browse files <ArrowRight size={13} />
              </span>
            </>
          )}
        </span>
      </span>
      <span className="file-requirement">PDF · up to 20 MB</span>
    </button>
  );

  const documentDetails = () => (
    <>
      {document ? (
        <div className="source-file">
          <div className="flex items-start gap-3">
            <span className="pdf-icon">
              <FileText size={21} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="source-file-name">{document.name}</p>
              <p className="meta-text">
                PDF document · {formatSize(document.size)}
              </p>
            </div>
          </div>
          <div className={`document-status ${hasFile ? "" : "needs-file"}`}>
            {hasFile ? <Check size={13} /> : <Upload size={13} />}
            {hasFile ? "Ready for questions" : "Reattach to continue"}
          </div>
          {previewUrl && (
            <a
              className="text-action"
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open document <ArrowRight size={13} />
            </a>
          )}
        </div>
      ) : (
        <div className="empty-source">
          <div className="source-stack">
            <FileText size={28} strokeWidth={1.2} />
          </div>
          <p>No document yet</p>
          <span>
            Your next discovery starts
            <br />
            with a single document.
          </span>
        </div>
      )}
      <button
        className="secondary-button source-upload"
        onClick={chooseFile}
        disabled={busy}
      >
        <Plus size={15} />
        {document
          ? hasFile
            ? "Replace document"
            : "Reattach document"
          : "Add a document"}
      </button>
      <p className="source-hint">
        One PDF per conversation. Upload a different document to start fresh.
      </p>
    </>
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
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}
        aria-label="Workspace navigation"
        role={sidebarOpen ? "dialog" : undefined}
        aria-modal={sidebarOpen || undefined}
        inert={sourcesOpen}
      >
        <div className="brand">
          <span className="brand-mark">
            <FileText size={21} strokeWidth={1.7} />
          </span>
          <span>
            Document<span className="brand-ai">AI</span>
          </span>
        </div>
        <div className="workspace-selector">
          <span className="workspace-avatar">P</span>
          <div>
            <strong>Personal workspace</strong>
            <span>A space for your ideas</span>
          </div>
        </div>
        <button
          className="new-chat-button"
          onClick={newConversation}
          disabled={busy}
        >
          <Plus size={17} />
          New conversation
          <span className="button-shortcut">
            <MessageSquare size={13} />
          </span>
        </button>
        <nav className="primary-nav" aria-label="Views">
          <button
            className={tab === "conversation" ? "nav-active" : ""}
            onClick={() => {
              setTab("conversation");
              setSidebarOpen(false);
            }}
          >
            <MessageSquare size={17} />
            Conversation{tab === "conversation" && <span className="nav-dot" />}
          </button>
          <button
            className={tab === "document" ? "nav-active" : ""}
            onClick={() => {
              setTab("document");
              setSidebarOpen(false);
            }}
          >
            <Layers3 size={17} />
            Document<span className="nav-count">{document ? "1" : "0"}</span>
          </button>
        </nav>
        <div className="history-heading">
          <span>RECENT CONVERSATIONS</span>
          <span>
            {conversations.filter((item) => item.turns.length).length || ""}
          </span>
        </div>
        <div className="history-list">
          {conversations.filter((item) => item.turns.length).length ? (
            conversations
              .filter((item) => item.turns.length)
              .map((item) => (
                <button
                  key={item.id}
                  title={item.title}
                  className={`history-item ${item.id === conversation.id ? "history-active" : ""}`}
                  disabled={busy}
                  onClick={() => switchConversation(item.id)}
                >
                  <MessageSquare size={14} />
                  <span>{item.title}</span>
                </button>
              ))
          ) : (
            <p className="history-empty">
              A good question is the start
              <br />
              of something worth keeping.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="note-flower">✳</span>
            <p>
              A little more clarity.
              <br />
              <strong>A lot more possibility.</strong>
            </p>
          </div>
          <button
            className="sidebar-utility"
            onClick={() => helpDialog.current?.showModal()}
          >
            <CircleHelp size={16} />
            Getting started
            <ArrowRight size={14} />
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
          <div className="profile">
            <span className="profile-avatar">Y</span>
            <div>
              <strong>Your workspace</strong>
              <span>Saved in this browser tab</span>
            </div>
            <span className="profile-dot" />
          </div>
        </div>
      </aside>
      <div className="workspace-main" inert={sidebarOpen}>
        <header className="topbar" inert={sourcesOpen}>
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-root">Workspace</span>
            <ChevronRight size={13} />
            <span>
              {tab === "document"
                ? "Document"
                : "New conversation" === conversation.title
                  ? "New conversation"
                  : "Conversation"}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="workspace-badge">
              <span />
              Personal workspace
            </span>
            <button
              className="export-button"
              onClick={exportConversation}
              disabled={!hasMessages || busy}
            >
              <ArrowDownToLine size={15} />
              <span>Export chat</span>
            </button>
            <button
              className="icon-button mobile-sources"
              aria-label="Show sources"
              onClick={() => setSourcesOpen(!sourcesOpen)}
            >
              <PanelRightClose size={18} />
            </button>
          </div>
        </header>
        <div className="content-grid">
          <main
            id="main-content"
            className="conversation-panel"
            inert={sourcesOpen}
          >
            <div className="conversation-toolbar">
              <div
                className="conversation-tabs"
                role="tablist"
                aria-label="Workspace view"
              >
                <button
                  role="tab"
                  aria-selected={tab === "conversation"}
                  aria-controls="conversation-content"
                  id="conversation-tab"
                  onClick={() => setTab("conversation")}
                >
                  <MessageSquare size={15} />
                  Conversation
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "document"}
                  aria-controls="document-content"
                  id="document-tab"
                  onClick={() => setTab("document")}
                >
                  <FileText size={15} />
                  Document{document && <span className="tab-count">1</span>}
                </button>
              </div>
              <span className="private-label">
                <span className="subtle-dot" />
                Your thinking space
              </span>
            </div>
            {tab === "conversation" ? (
              <section
                id="conversation-content"
                role="tabpanel"
                aria-labelledby="conversation-tab"
                className={`conversation-scroll ${hasMessages ? "has-messages" : ""}`}
              >
                {hasMessages ? (
                  <div className="transcript">
                    <div className="transcript-heading">
                      <span className="eyebrow">
                        A CONVERSATION WITH YOUR DOCUMENT
                      </span>
                      <h1>{conversation.title}</h1>
                      <p>
                        <FileText size={13} />
                        {document?.name}
                      </p>
                    </div>
                    {conversation.turns.map((turn) => (
                      <AnswerCard
                        key={turn.id}
                        turn={turn}
                        retryDisabled={busy || !hasFile}
                        onRetry={() =>
                          void sendQuestion(turn.question, turn.id)
                        }
                      />
                    ))}
                    <div ref={scrollEnd} />
                  </div>
                ) : (
                  <div className="welcome-content">
                    <div className="welcome-art" aria-hidden="true">
                      <div className="art-orbit" />
                      <div className="art-page art-page-back">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div className="art-page art-page-front">
                        <span className="art-page-corner" />
                        <span className="art-line art-line-short" />
                        <span className="art-line" />
                        <span className="art-line" />
                        <span className="art-line art-line-medium" />
                        <span className="art-page-globe">
                          <Globe2 size={21} strokeWidth={1.4} />
                        </span>
                      </div>
                      <span className="art-sparkle">
                        <Sparkles size={23} strokeWidth={1.5} />
                      </span>
                      <span className="art-dot" />
                    </div>
                    <div className="welcome-label">
                      <span />
                      YOUR KNOWLEDGE, CONNECTED
                    </div>
                    <h1>
                      Good questions.
                      <br />
                      <em>Grounded answers.</em>
                    </h1>
                    <p className="welcome-description">
                      Make sense of your documents. Bring in the bigger picture.
                      <br className="desktop-break" /> A thoughtful answer
                      starts here.
                    </p>
                    {hasFile ? (
                      <div className="ready-document">
                        <span className="pdf-icon">
                          <FileText size={24} />
                        </span>
                        <div>
                          <strong>{document?.name}</strong>
                          <span>
                            <Check size={12} />
                            Ready to explore · {formatSize(document?.size ?? 0)}
                          </span>
                        </div>
                        <button
                          className="icon-button"
                          title="Replace document"
                          aria-label="Replace document"
                          onClick={chooseFile}
                          disabled={busy}
                        >
                          <Upload size={17} />
                        </button>
                      </div>
                    ) : (
                      uploadZone()
                    )}
                    <div className="suggestion-label">
                      A LITTLE INSPIRATION TO GET STARTED
                    </div>
                    <div className="suggestions">
                      {suggestions.map(
                        ({ icon: Icon, title, description, prompt }) => (
                          <button
                            key={title}
                            className="suggestion-card"
                            onClick={() => {
                              setDraft(prompt);
                              window.document
                                .querySelector<HTMLTextAreaElement>("textarea")
                                ?.focus();
                            }}
                          >
                            <Icon size={19} strokeWidth={1.5} />
                            <strong>{title}</strong>
                            <span>{description}</span>
                            <ArrowRight
                              className="suggestion-arrow"
                              size={14}
                            />
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                )}
              </section>
            ) : (
              <section
                id="document-content"
                role="tabpanel"
                aria-labelledby="document-tab"
                className="document-view"
              >
                <span className="eyebrow">YOUR SOURCE MATERIAL</span>
                <h1>A place for your next discovery.</h1>
                <p>Bring a document. Leave with a clearer perspective.</p>
                {uploadZone()}
                <div className="document-view-details">{documentDetails()}</div>
              </section>
            )}
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
              <p className="composer-footnote">
                A little curiosity goes a long way. Always double-check
                important answers.
              </p>
            </div>
          </main>
          {sourcesOpen && (
            <button
              className="sources-backdrop"
              aria-label="Close sources"
              onClick={() => setSourcesOpen(false)}
            />
          )}
          <aside
            ref={sourcesRef}
            className={`sources-panel ${sourcesOpen ? "sources-open" : ""}`}
            aria-label="Sources and context"
            role={sourcesOpen ? "dialog" : undefined}
            aria-modal={sourcesOpen || undefined}
          >
            <div className="sources-heading">
              <div>
                <Layers3 size={17} />
                <h2>Sources & context</h2>
              </div>
              <button
                className="icon-button mobile-sources"
                aria-label="Close sources panel"
                onClick={() => setSourcesOpen(false)}
              >
                <X size={17} />
              </button>
              <span className="source-total">{document ? 1 : 0}</span>
            </div>
            <div className="sources-section">
              <div className="section-label">
                <span>YOUR DOCUMENT</span>
                <FileText size={13} />
              </div>
              {documentDetails()}
            </div>
            <div className="sources-section connected-section">
              <div className="section-label">
                <span>A WIDER PERSPECTIVE</span>
                <Globe2 size={13} />
              </div>
              <div className="web-source">
                <span className="web-source-icon">
                  <Globe2 size={19} />
                </span>
                <div>
                  <strong>Web search</strong>
                  <span>Included with each question</span>
                </div>
                <span className="web-source-dot" />
              </div>
              <p className="source-hint">
                Connect what’s in your document with information from the web.
              </p>
            </div>
            <div className="how-it-works">
              <span className="how-eyebrow">FROM INFORMATION TO INSIGHT</span>
              <h3>
                Two perspectives.
                <br />
                One clearer picture.
              </h3>
              <div className="connection-graphic" aria-hidden="true">
                <span>
                  <FileText size={21} strokeWidth={1.4} />
                </span>
                <i />
                <span className="connection-center">
                  <Sparkles size={20} strokeWidth={1.4} />
                </span>
                <i />
                <span>
                  <Globe2 size={21} strokeWidth={1.4} />
                </span>
              </div>
              <p>
                Document knowledge and web context, presented side by side so
                you can see the full story.
              </p>
              <button
                className="text-action"
                onClick={() => helpDialog.current?.showModal()}
              >
                How it works <ArrowRight size={13} />
              </button>
            </div>
            <div className="sources-footer">
              <span className="brand-mini">
                <FileText size={14} />
              </span>
              Made for curious minds.
            </div>
          </aside>
        </div>
      </div>
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
        <span className="dialog-symbol">
          <Sparkles size={25} />
        </span>
        <h2 id="help-title">A little more understanding.</h2>
        <p>Three simple steps to a fresh perspective.</p>
        <ol className="help-steps">
          <li>
            <span>01</span>
            <div>
              <strong>Bring your document</strong>
              <p>
                Upload one PDF, up to 20 MB. A different document starts a fresh
                conversation.
              </p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Ask a good question</strong>
              <p>
                Get a document answer and a web answer. Each question stands on
                its own, so include the context you need.
              </p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Keep what matters</strong>
              <p>
                Copy answers or export your conversation. History stays in this
                browser tab; reattach your PDF after a refresh.
              </p>
            </div>
          </li>
        </ol>
        <button
          className="primary-button"
          onClick={() => helpDialog.current?.close()}
        >
          Let’s explore <ArrowRight size={16} />
        </button>
      </dialog>
      <dialog
        ref={clearDialog}
        aria-labelledby="clear-title"
        className="workspace-dialog clear-dialog"
      >
        <span className="dialog-symbol">
          <Trash2 size={24} />
        </span>
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
