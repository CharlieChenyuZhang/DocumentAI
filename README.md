# Document AI

A document research workspace built with Next.js, React, TypeScript, and Tailwind CSS. Upload a PDF, ask a question, and read document and web answers side by side.

![Document AI workspace](docs/screenshots/workspace-desktop.png)

[Mobile workspace](docs/screenshots/workspace-mobile.png)

## Run the frontend

Use Node.js 24 LTS (`.nvmrc` is included), or Node.js 22.13+.

```sh
nvm use
npm ci
cp .env.example .env.local
npm run dev
```

Open [localhost:3000](http://localhost:3000). The frontend connects to `http://localhost:5001` by default. Set `NEXT_PUBLIC_API_BASE_URL` in `.env.local` to point to your existing backend. This public URL is embedded at build time; use an HTTPS backend when serving the frontend over HTTPS. The backend must allow requests from the frontend origin through CORS.

Start your existing backend separately. If the original `server/` directory is available locally, `npm run server` runs its existing start command. Backend source, credentials, dependencies, and uploaded documents are outside the scope of this frontend PR.

For production:

```sh
npm run build
npm start
```

## Workspace features

- Two-column workspace with chat history and a focused conversation area. Document details open on demand in a keyboard-accessible drawer.
- Single-PDF upload by browsing or drag and drop, with file validation, loading feedback, and recoverable errors. The frontend limits uploads to 20 MiB.
- Separate document and web answers with safe Markdown, code blocks, tables, copy, and read aloud when supported by the browser.
- Suggested questions, editable voice dictation when supported, IME-safe keyboard submission, retry, and cancellation of local waiting.
- Conversation history in this browser tab, Markdown export, and explicit local-history clearing.
- No remote fonts or generated-answer image requests. Answer links only allow HTTP, HTTPS, and mailto URLs.

## Layout references

The layout draws on [ChatPDF](https://www.chatpdf.com/)'s direct upload-and-chat workflow, [NotebookLM](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-new-features-december-2024/)'s task-focused panels, and [Claude Projects](https://www.anthropic.com/news/projects)' organization of chats and reference material. For this single-document app, the default view is limited to history and chat. Document details appear on request, and short suggested questions replace large cards. The layout uses readable sans-serif text, light borders, and a single accent color.

## Unchanged backend contract

| Operation | Existing request                            | Existing response                            |
| --------- | ------------------------------------------- | -------------------------------------------- |
| Upload    | `POST /upload`, multipart form field `file` | Plain-text acknowledgement                   |
| Question  | `GET /chat?question=...`                    | `{ "ragAnswer": "...", "mcpAnswer": "..." }` |

The browser calls these endpoints directly through `src/lib/api.ts`. The frontend introduces no Route Handlers and changes no backend APIs.

The existing backend keeps one active PDF shared across requests. Before each question, the frontend re-uploads the PDF belonging to that conversation. This keeps document switching consistent within the current page. It does not provide isolation between multiple clients sharing that backend; that requires a backend document/session identifier.

Files are held in memory, while conversation text and file metadata are saved in `sessionStorage`. A refresh restores the text but requires the original PDF to be attached again. File identity for reattachment uses name, size, and last-modified time. A changed file starts a new conversation once questions exist. At most 30 conversations are retained, and unreferenced file objects are released. Clearing local history does not delete server-side uploads.

Each question is independent: the existing API accepts a question, not conversation history. Both document retrieval and web search are invoked by the backend. A loading indicator reflects the pending request; it does not claim live tool progress. Stopping a response cancels browser waiting and prevents a late answer from being added, but cannot cancel work already running on the server.

ADK orchestration, Pinecone indexing, model selection, and an AG-UI/CopilotKit event transport are backend capabilities and are not implemented or advertised by this frontend migration. The current JSON contract has no streaming events, citations, document listing, or document deletion endpoint.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit tests cover the API contract, errors, timeouts, cancellation, safe answer rendering, clipboard/read-aloud behavior, keyboard submission, and speech cleanup. Playwright covers upload, answers, retries, stopped responses, document switching, history restoration, export, and mobile navigation. Browser tests intercept the existing endpoints and block external network requests, so they do not consume AI credits or depend on backend credentials.

The Next.js and Tailwind setup follows their [App Router installation guide](https://nextjs.org/docs/app/getting-started/installation) and [Next.js framework guide](https://tailwindcss.com/docs/installation/framework-guides/nextjs).
