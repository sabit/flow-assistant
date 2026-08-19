## Flow Assistant

A compact, browser-owned workflow workbench built on [assistant-ui](https://github.com/assistant-ui/assistant-ui).

The vertical slice supports:

- JSON workflow import, AJV/schema + graph validation, and clipboard export
- Mermaid workflow visualization and node inspection
- Revision-aware node context for assistant conversations
- RFC 6902 AI patch proposals, validation, review, apply/reject, and immutable restore history
- IndexedDB persistence for workflow documents and revisions

## Getting Started

Create `.env.local` for the server-side Ollama connection:

```
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_API_KEY=ollama
```

Then, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

Use an Ollama model with tool/function-calling support. Provider configuration remains on the server in `app/api/chat/route.ts`; no API credentials are exposed to the browser.
