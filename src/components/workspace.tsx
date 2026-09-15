"use client";

import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { CopilotKit, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  ArrowDownToLine,
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
import {
  ApiError,
  deleteDocument,
  getSession,
  listDocuments,
  uploadDocument,
  validatePdf,
  type DocumentInfo,
  type SessionInfo,
} from "../lib/api";
import {
  citationsFromState,
  conversationMarkdown,
  conversationMessages,
  createConversation,
  formatSize,
  restoreConversations,
  searchMetadataFromState,
  STORAGE_KEY,
  webSourcesFromState,
  type Conversation,
  type Turn,
} from "../lib/workspace";
import { Composer } from "./composer";
import { AnswerCard } from "./answer-card";

const suggestions = [
  {
    title: "Summarize",
    prompt:
      "Summarize the key ideas across the selected documents and highlight the most important takeaways.",
  },
  {
    title: "Compare findings",
    prompt:
      "Compare the key findings in the selected documents. Where do they agree or differ?",
  },
  {
    title: "Explore context",
    prompt:
      "Explain the main topic of these documents and compare it with relevant information from the web.",
  },
];
class AgentBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="session-screen">
        <h1>Document AI is unavailable</h1>
        <p>
          The assistant could not connect. Please check the service and try
          again.
        </p>
        <button
          className="primary-button"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}

export function Workspace() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void getSession({ signal: controller.signal })
        .then((result) => {
          setSession(result);
          setError("");
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setSession(null);
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not load your session.",
            );
          }
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, []);
  if (error)
    return (
      <main className="session-screen">
        <h1>Document AI</h1>
        <p role="alert">{error}</p>
        <button
          className="primary-button"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </main>
    );
  if (!session)
    return (
      <main className="session-screen">
        <LoaderCircle className="animate-spin" size={22} />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  if (!session.authenticated || !session.user)
    return (
      <main className="session-screen">
        <FileText size={30} />
        <h1>Your document workspace</h1>
        <p>
          Sign in to upload documents and ask questions about your own library.
        </p>
        <form action="/api/auth/signin" method="get">
          <button className="primary-button" type="submit">
            Continue with GitHub
          </button>
        </form>
      </main>
    );
  const vectorBackend =
    session.configuration?.vector_backend === "local" ? "local" : "pinecone";
  return (
    <AgentBoundary key={`${session.user.id}:${vectorBackend}`}>
      <CopilotKit
        runtimeUrl="/api/copilotkit"
        useSingleEndpoint={false}
        agentId="document_ai"
        enableInspector={false}
        showDevConsole={false}
        credentials="same-origin"
      >
        <DocumentWorkspace
          user={session.user}
          vectorBackend={vectorBackend}
          availableWebSearch={session.configuration?.web_search === true}
        />
      </CopilotKit>
    </AgentBoundary>
  );
}

type ActiveRun = {
  conversationId: string;
  turnId: string;
  messageId: string;
  stopped: boolean;
  error?: string;
};
function DocumentWorkspace({
  user,
  vectorBackend,
  availableWebSearch,
}: {
  user: NonNullable<SessionInfo["user"]>;
  vectorBackend: "local" | "pinecone";
  availableWebSearch: boolean;
}) {
  const { agent, isReady } = useAgent({ agentId: "document_ai" });
  const { copilotkit } = useCopilotKit();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [documentLoadError, setDocumentLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "answering">(
    "idle",
  );
  const [webPreference, setWebPreference] = useState(availableWebSearch);
  const webEnabled = availableWebSearch && webPreference;
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const documentController = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const activeRun = useRef<ActiveRun | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const documentDialog = useRef<HTMLDialogElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const clearDialog = useRef<HTMLDialogElement>(null);
  const scrollEnd = useRef<HTMLDivElement>(null);
  const scrollPanel = useRef<HTMLElement>(null);
  const followAnswer = useRef(true);
  const storageKey = `${STORAGE_KEY}:${user.id}${vectorBackend === "local" ? ":local" : ""}`;
  const conversation = conversations.find((item) => item.id === activeId);
  const selectedDocuments = documents.filter((document) =>
    conversation?.documentIds.includes(document.id),
  );
  const readyDocuments = selectedDocuments.filter(
    (document) => document.status === "ready",
  );
  const busy = phase !== "idle";
  const hasMessages = Boolean(conversation?.turns.length);

  const updateConversation = useCallback(
    (id: string, change: (item: Conversation) => Conversation) => {
      setConversations((items) =>
        items.map((item) => (item.id === id ? change(item) : item)),
      );
    },
    [],
  );

  const refreshDocuments = useCallback(async () => {
    documentController.current?.abort();
    const request = new AbortController();
    documentController.current = request;
    setLoadingDocuments(true);
    setDocumentLoadError("");
    try {
      const loadedDocuments = await listDocuments({ signal: request.signal });
      if (!request.signal.aborted) setDocuments(loadedDocuments);
    } catch (cause) {
      if (!request.signal.aborted) {
        setDocumentLoadError(
          cause instanceof Error
            ? cause.message
            : "The document service is unavailable. Please try again.",
        );
      }
    } finally {
      if (!request.signal.aborted) setLoadingDocuments(false);
      if (documentController.current === request)
        documentController.current = null;
    }
  }, []);

  useEffect(() => {
    let restored: Conversation[] = [];
    try {
      restored = restoreConversations(sessionStorage.getItem(storageKey));
    } catch {
      /* Browser storage is optional. */
    }
    const initial = restored.length ? restored : [createConversation()];
    setConversations(initial);
    setActiveId(initial[0].id);
    setHydrated(true);
    void refreshDocuments();
    return () => {
      documentController.current?.abort();
      controller.current?.abort();
    };
  }, [storageKey, refreshDocuments]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(conversations));
    } catch {
      /* Continue in memory when storage is unavailable. */
    }
  }, [conversations, hydrated, storageKey]);
  useEffect(
    () => () => {
      if (agent.isRunning) copilotkit.stopAgent({ agent });
    },
    [agent, copilotkit],
  );

  useEffect(() => {
    if (!isReady) return;
    const sync = () => {
      const run = activeRun.current;
      if (!run || run.stopped) return;
      const start = agent.messages.findIndex(
        (message) => message.id === run.messageId,
      );
      if (start < 0) return;
      const answer = agent.messages
        .slice(start + 1)
        .filter(
          (message) =>
            message.role === "assistant" && typeof message.content === "string",
        )
        .map((message) => message.content)
        .join("\n\n");
      const state = agent.state as Record<string, unknown>;
      const search = searchMetadataFromState(state);
      updateConversation(run.conversationId, (item) => ({
        ...item,
        turns: item.turns.map((turn) =>
          turn.id === run.turnId
            ? {
                ...turn,
                answer,
                phase:
                  typeof state.phase === "string" ? state.phase : undefined,
                citations: citationsFromState(state.sources ?? state.citations),
                webSources: webSourcesFromState(
                  state.sources ?? state.web_sources,
                ),
                ...search,
                searchMode: search.searchMode ?? turn.searchMode,
                webSearchStatus: search.webSearchStatus ?? turn.webSearchStatus,
              }
            : turn,
        ),
      }));
    };
    const subscription = agent.subscribe({
      onMessagesChanged: sync,
      onStateChanged: sync,
      onRunErrorEvent: () => {
        if (activeRun.current)
          activeRun.current.error =
            "The assistant could not finish this answer. Please check the service configuration and try again.";
      },
      onToolCallStartEvent: ({ event }) => {
        const run = activeRun.current;
        if (!run || run.stopped) return;
        const toolPhase = /search_web|web_search/i.test(event.toolCallName)
          ? "web_search"
          : /retriev|search_document/i.test(event.toolCallName)
            ? "retrieving"
            : "planning";
        updateConversation(run.conversationId, (item) => ({
          ...item,
          turns: item.turns.map((turn) =>
            turn.id === run.turnId ? { ...turn, phase: toolPhase } : turn,
          ),
        }));
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, isReady, updateConversation]);

  useEffect(() => {
    if (followAnswer.current && scrollPanel.current)
      scrollPanel.current.scrollTop = scrollPanel.current.scrollHeight;
  }, [conversation?.turns]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const previousFocus = window.document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (helpDialog.current?.open || clearDialog.current?.open) return;
      if (event.key === "Escape") setSidebarOpen(false);
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
    };
    window.document.addEventListener("keydown", onKeyDown);
    return () => {
      window.document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [sidebarOpen]);

  function chooseFile() {
    if (!busy) fileInput.current?.click();
  }
  function selectConversation(next: Conversation) {
    if (locked.current) return;
    if (agent.isRunning) copilotkit.stopAgent({ agent });
    agent.threadId = next.id;
    agent.setMessages(conversationMessages(next));
    agent.setState({ document_ids: next.documentIds, web_enabled: webEnabled });
    followAnswer.current = true;
    setActiveId(next.id);
    setDraft("");
    setError("");
    setNotice("");
    setSidebarOpen(false);
  }
  function newConversation() {
    if (locked.current) return;
    const next = createConversation(conversation?.documentIds ?? []);
    setConversations((items) =>
      [next, ...items.filter((item) => item.turns.length)].slice(0, 30),
    );
    selectConversation(next);
  }
  async function attachFiles(files: File[]) {
    if (locked.current || !conversation || !files.length) return;
    const invalid = files.map(validatePdf).find(Boolean);
    if (invalid) {
      setError(invalid);
      return;
    }
    locked.current = true;
    setPhase("uploading");
    setError("");
    const request = new AbortController();
    controller.current = request;
    try {
      for (const file of files) {
        setUploadName(file.name);
        const document = await uploadDocument(file, { signal: request.signal });
        setDocuments((items) => [
          ...items.filter((item) => item.id !== document.id),
          document,
        ]);
        updateConversation(conversation.id, (item) => ({
          ...item,
          documentIds: [...new Set([...item.documentIds, document.id])],
        }));
      }
      setNotice(
        `${files.length} ${files.length === 1 ? "document is" : "documents are"} ready for questions.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
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
    if (!busy) void attachFiles(Array.from(event.dataTransfer.files));
  }
  function toggleDocument(id: string) {
    if (!conversation || busy) return;
    updateConversation(conversation.id, (item) => ({
      ...item,
      documentIds: item.documentIds.includes(id)
        ? item.documentIds.filter((value) => value !== id)
        : [...item.documentIds, id],
    }));
  }
  async function removeDocument(document: DocumentInfo) {
    if (locked.current) return;
    locked.current = true;
    setPhase("uploading");
    setError("");
    try {
      await deleteDocument(document.id);
      setDocuments((items) => items.filter((item) => item.id !== document.id));
      setConversations((items) =>
        items.map((item) => ({
          ...item,
          documentIds: item.documentIds.filter((id) => id !== document.id),
        })),
      );
      setNotice(`${document.name} deleted.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete this document.",
      );
    } finally {
      locked.current = false;
      setPhase("idle");
    }
  }
  async function sendQuestion(question = draft, retryId?: string) {
    const cleanQuestion = question.trim();
    if (
      locked.current ||
      !isReady ||
      !conversation ||
      !cleanQuestion ||
      !readyDocuments.length ||
      (retryId !== undefined && conversation.turns.at(-1)?.id !== retryId)
    )
      return;
    locked.current = true;
    followAnswer.current = true;
    setPhase("answering");
    setError("");
    setNotice("");
    if (!retryId) setDraft("");
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const turn: Turn = {
      messageId,
      id: retryId ?? crypto.randomUUID(),
      question: cleanQuestion,
      documentName: readyDocuments.map((document) => document.name).join(", "),
      status: "pending",
      answer: "",
      phase: "planning",
      searchMode: webEnabled ? "hybrid" : "documents",
      webSearchStatus: webEnabled ? "pending" : "disabled",
      warnings: [],
    };
    // Only the latest turn can be retried because the server retains conversation history.
    updateConversation(conversation.id, (item) => ({
      ...item,
      title: item.turns.length ? item.title : cleanQuestion.slice(0, 60),
      turns: retryId
        ? item.turns.map((previous) =>
            previous.id === retryId ? turn : previous,
          )
        : [...item.turns, turn],
    }));
    agent.threadId = conversation.id;
    agent.setMessages(conversationMessages(conversation, retryId));
    agent.setState({
      document_ids: readyDocuments.map((document) => document.id),
      web_enabled: webEnabled,
      phase: "planning",
      sources: [],
      search_mode: webEnabled ? "hybrid" : "documents",
      web_search_status: webEnabled ? "pending" : "disabled",
      web_search_reason: null,
      warnings: [],
    });
    const run: ActiveRun = {
      conversationId: conversation.id,
      turnId: turn.id,
      messageId,
      stopped: false,
    };
    activeRun.current = run;
    agent.addMessage({ id: messageId, role: "user", content: cleanQuestion });
    // Scope cancellation to this exact run so a delayed stop cannot cancel its retry.
    copilotkit.setHeaders({ "x-documentai-run-id": runId });
    try {
      await copilotkit.runAgent({ agent, runId });
      if (run.error) throw new Error(run.error);
      if (
        !run.stopped &&
        !agent.messages.some(
          (message) =>
            message.role === "assistant" &&
            typeof message.content === "string" &&
            message.content.trim() &&
            agent.messages.indexOf(message) >
              agent.messages.findIndex((message) => message.id === messageId),
        )
      )
        throw new Error("No answer was returned. Please try again.");
      updateConversation(run.conversationId, (item) => ({
        ...item,
        turns: item.turns.map((previous) =>
          previous.id === turn.id
            ? { ...previous, status: run.stopped ? "stopped" : "complete" }
            : previous,
        ),
      }));
    } catch (cause) {
      updateConversation(run.conversationId, (item) => ({
        ...item,
        turns: item.turns.map((previous) =>
          previous.id === turn.id
            ? {
                ...previous,
                status: run.stopped ? "stopped" : "error",
                error: run.stopped
                  ? undefined
                  : cause instanceof ApiError
                    ? cause.message
                    : "The assistant could not finish this answer. Please check the service configuration and try again.",
              }
            : previous,
        ),
      }));
    } finally {
      if (activeRun.current === run) activeRun.current = null;
      locked.current = false;
      setPhase("idle");
    }
  }
  function stopRun() {
    const run = activeRun.current;
    if (!run) return;
    run.stopped = true;
    updateConversation(run.conversationId, (item) => ({
      ...item,
      turns: item.turns.map((turn) =>
        turn.id === run.turnId ? { ...turn, status: "stopped" } : turn,
      ),
    }));
    copilotkit.stopAgent({ agent });
  }
  function exportConversation() {
    if (!conversation) return;
    const url = URL.createObjectURL(
      new Blob([conversationMarkdown(conversation)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "document-ai-conversation.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Conversation exported as Markdown.");
  }
  function clearHistory() {
    if (busy) return;
    const next = createConversation();
    setConversations([next]);
    selectConversation(next);
    clearDialog.current?.close();
    setNotice(
      "Local conversation history cleared. Your document library is unchanged.",
    );
  }

  const uploadZone = (
    <button
      type="button"
      className={`upload-zone ${dragging ? "is-dragging" : ""}`}
      onClick={chooseFile}
      disabled={busy || loadingDocuments}
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
          {phase === "uploading" ? "Adding your documents…" : "Upload PDFs"}
        </strong>
        <span>
          {phase === "uploading"
            ? uploadName
            : "Choose files or drag them here"}
        </span>
      </span>
      <span className="file-requirement">Up to 20 MB each</span>
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
        multiple
        accept=".pdf,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload PDF documents"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void attachFiles(files);
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
          disabled={busy || !hydrated}
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
                  className={`history-item ${item.id === activeId ? "history-active" : ""}`}
                  aria-current={item.id === activeId ? "page" : undefined}
                  disabled={busy}
                  onClick={() => selectConversation(item)}
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
            disabled={busy || !conversations.some((item) => item.turns.length)}
          >
            <Trash2 size={15} />
            Clear local history
          </button>
          <p className="storage-note">
            {user.kind === "github"
              ? user.name || "Signed in with GitHub"
              : "Private browser session"}
            <br />
            Chat history stays in this tab.
          </p>
          {user.kind === "github" && (
            <form action="/api/auth/signout" method="get">
              <button className="sidebar-utility" type="submit">
                Sign out
              </button>
            </form>
          )}
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
            <span title={conversation?.title}>
              {conversation?.title || "New conversation"}
            </span>
          </div>
          <div className="topbar-actions">
            <button
              className="header-button"
              aria-label="Show documents"
              onClick={() => documentDialog.current?.showModal()}
            >
              <FileText size={16} />
              <span>Documents</span>
              {selectedDocuments.length > 0 && (
                <span className="document-count">
                  {selectedDocuments.length}
                </span>
              )}
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
            ref={scrollPanel}
            onScroll={(event) => {
              const panel = event.currentTarget;
              followAnswer.current =
                panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
            }}
          >
            {hasMessages ? (
              <div className="transcript">
                <h1 className="sr-only">{conversation?.title}</h1>
                {conversation?.turns.map((turn, index) => (
                  <AnswerCard
                    key={turn.id}
                    turn={turn}
                    retryDisabled={
                      busy ||
                      !readyDocuments.length ||
                      index !== conversation.turns.length - 1
                    }
                    onRetry={() => void sendQuestion(turn.question, turn.id)}
                  />
                ))}
                <div ref={scrollEnd} />
              </div>
            ) : (
              <div className="welcome-content">
                <h1>Ask your documents</h1>
                <p className="welcome-description">
                  Upload PDFs, compare their findings, and get answers with
                  sources.
                </p>
                {readyDocuments.length && phase !== "uploading" ? (
                  <div className="ready-document">
                    <FileText size={22} />
                    <div>
                      <strong>
                        {readyDocuments.length === 1
                          ? readyDocuments[0].name
                          : `${readyDocuments.length} documents selected`}
                      </strong>
                      <span>
                        <Check size={13} />
                        Ready for questions
                      </span>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => documentDialog.current?.showModal()}
                    >
                      Manage
                    </button>
                  </div>
                ) : (
                  uploadZone
                )}
                {documents.length > 0 && !readyDocuments.length && (
                  <button
                    className="library-link"
                    onClick={() => documentDialog.current?.showModal()}
                  >
                    Choose from your library ({documents.length})
                  </button>
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
            {loadingDocuments && (
              <p className="upload-progress" role="status">
                <LoaderCircle className="animate-spin" size={15} />
                Loading your documents…
              </p>
            )}
            {documentLoadError && (
              <div className="inline-alert" role="alert">
                <CircleHelp size={16} />
                <span>
                  <strong>Could not load your documents.</strong>{" "}
                  {documentLoadError}
                </span>
                <button
                  className="secondary-button"
                  disabled={busy || loadingDocuments}
                  onClick={() => void refreshDocuments()}
                >
                  Retry documents
                </button>
              </div>
            )}
            {error && (
              <div className="inline-alert" role="alert">
                <CircleHelp size={16} />
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {phase === "uploading" && hasMessages && (
              <p className="upload-progress" role="status">
                <LoaderCircle className="animate-spin" size={15} />
                Adding {uploadName}…
              </p>
            )}
            <span className="sr-only" role="status">
              {notice}
            </span>
            <div className="retrieval-controls">
              <button
                disabled={busy}
                onClick={() => documentDialog.current?.showModal()}
              >
                {readyDocuments.length}{" "}
                {readyDocuments.length === 1 ? "document" : "documents"}{" "}
                selected
              </button>
              <label title="Search public topics from your question and combine relevant web results with your documents.">
                <input
                  type="checkbox"
                  checked={webEnabled}
                  disabled={busy || !availableWebSearch}
                  onChange={(event) => setWebPreference(event.target.checked)}
                />
                {availableWebSearch
                  ? "Include web search"
                  : "Web search unavailable"}
              </label>
            </div>
            <Composer
              key={activeId}
              value={draft}
              onChange={setDraft}
              onSubmit={() => void sendQuestion()}
              onStop={stopRun}
              disabled={phase === "uploading" || !isReady || loadingDocuments}
              busy={phase === "answering"}
              hasDocument={readyDocuments.length > 0}
              webEnabled={webEnabled}
              onUpload={chooseFile}
            />
            {!isReady && (
              <p className="meta-text" role="status">
                Connecting to the assistant…
              </p>
            )}
          </div>
        </main>
      </div>
      <dialog
        ref={documentDialog}
        className="document-dialog"
        aria-labelledby="documents-title"
      >
        <div className="document-dialog-content">
          <div className="document-panel-header">
            <h2 id="documents-title">Your documents</h2>
            <button
              className="icon-button"
              aria-label="Close documents"
              onClick={() => documentDialog.current?.close()}
            >
              <X size={18} />
            </button>
          </div>
          <div className="document-details">
            <p className="document-library-hint">
              Select the documents to search in this conversation.
            </p>
            {loadingDocuments && <p role="status">Loading your documents…</p>}
            {documentLoadError && (
              <div className="document-library-error" role="alert">
                <p>
                  <strong>Could not load your documents.</strong>{" "}
                  {documentLoadError}
                </p>
                <button
                  className="secondary-button"
                  disabled={busy || loadingDocuments}
                  onClick={() => void refreshDocuments()}
                >
                  Retry documents
                </button>
              </div>
            )}
            {documents.length > 0 && (
              <ul className="document-library">
                {documents.map((document) => (
                  <li key={document.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(
                          conversation?.documentIds.includes(document.id),
                        )}
                        disabled={busy || document.status !== "ready"}
                        onChange={() => toggleDocument(document.id)}
                      />
                      <span>
                        <strong>{document.name}</strong>
                        <small>
                          {formatSize(document.size)} · {document.pages} pages ·{" "}
                          {document.status === "ready"
                            ? "Ready"
                            : document.status}
                        </small>
                      </span>
                    </label>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${document.name}`}
                      disabled={busy}
                      onClick={() => void removeDocument(document)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!loadingDocuments &&
              !documentLoadError &&
              documents.length === 0 && (
                <p className="empty-source">Your library is empty.</p>
              )}
            <button
              className="primary-button"
              onClick={chooseFile}
              disabled={busy || loadingDocuments}
            >
              <Plus size={16} />
              Add documents
            </button>
            {phase === "uploading" && (
              <p className="upload-progress" role="status">
                Adding {uploadName}…
              </p>
            )}
            {error && (
              <p className="document-library-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <p className="source-hint">
            Documents are saved to your workspace. You can select several for
            one question.
          </p>
        </div>
      </dialog>
      <dialog
        ref={helpDialog}
        className="workspace-dialog"
        aria-labelledby="help-title"
      >
        <button
          className="icon-button dialog-close"
          aria-label="Close getting started"
          onClick={() => helpDialog.current?.close()}
        >
          <X size={18} />
        </button>
        <h2 id="help-title">Getting started</h2>
        <ol className="help-steps">
          <li>
            <strong>Add your PDFs</strong>
            <p>
              Upload one or more PDFs. They stay in your document library for
              future conversations.
            </p>
          </li>
          <li>
            <strong>Choose what to search</strong>
            <p>
              Use Documents to select the PDFs for this chat. Turn web search on
              when you need external context.
            </p>
          </li>
          <li>
            <strong>Ask and check sources</strong>
            <p>
              Read the answer as it arrives, follow the progress, and open
              Sources to check document pages and web references.
            </p>
          </li>
        </ol>
        <p>
          {user.kind === "session"
            ? "Your library belongs to this browser session. Clearing its session cookie loses access; use account sign-in for access across browsers."
            : "Your library belongs to your signed-in account."}
        </p>
      </dialog>
      <dialog
        ref={clearDialog}
        className="workspace-dialog"
        aria-labelledby="clear-title"
      >
        <h2 id="clear-title">Clear local history?</h2>
        <p>
          This removes conversation history from this tab. Your uploaded
          documents stay in your library.
        </p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            onClick={() => clearDialog.current?.close()}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={clearHistory}
            disabled={busy}
          >
            Clear history
          </button>
        </div>
      </dialog>
    </div>
  );
}
