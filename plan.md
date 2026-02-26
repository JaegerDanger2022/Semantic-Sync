# Project Blueprint: Semantic Sync

## 1. Project Overview

We are building "Semantic Sync," a multi-tenant developer tool for the Elastic ESRE Hackathon. It consists of a VS Code Extension (frontend) and a FastAPI server (middleware).
The goal is to allow users to index their local workspaces into an Elasticsearch Serverless cluster and chat with an Elastic Agent about their code.

## 2. Repository Structure

Please structure the project as a monorepo with two distinct directories:

- `/backend`: The FastAPI Python server.
- `/extension`: The TypeScript VS Code extension.

---

## 3. The Backend (`/backend`)

Build a FastAPI application that securely routes requests between the VS Code extension and the Elastic Cloud.

### Requirements:

- **Dependencies**: `fastapi`, `uvicorn`, `elasticsearch`, `httpx`, `pydantic`, `python-dotenv`.
- **Environment Variables**: `ELASTIC_URL`, `ELASTIC_API_KEY`, `KIBANA_URL`, `AGENT_ID`.

### Pydantic Models:

- `FileItem`: `file_path` (str), `content` (str)
- `IngestRequest`: `user_id` (str), `workspace_id` (str), `files` (List[FileItem])
- `ChatRequest`: `user_id` (str), `workspace_id` (str), `message` (str)

### Endpoint 1: `POST /api/ingest`

1. Accepts the `IngestRequest`.
2. Initializes the `elasticsearch` Python client.
3. Iterates over `files` and indexes each document into the `semantic-sync-data` index.
4. Document schema:

   ```python
   {
       "user_id": request.user_id,
       "workspace_id": request.workspace_id,
       "file_path": file.file_path,
       "content": file.content,
       "timestamp": datetime.now(timezone.utc).isoformat()
   }

   Return a success response with the count of indexed files.
   ```

Endpoint 2: POST /api/chat
Accepts the ChatRequest.

Uses httpx.AsyncClient to make a direct POST request to: {KIBANA_URL}/api/interpreter/agent/{AGENT_ID}/converse.

Headers: Authorization: ApiKey {ELASTIC_API_KEY}, kbn-xsrf: true.

Body payload:

Python
{
"messages": [{"role": "user", "content": request.message}],
"context": {
"user_id": request.user_id,
"workspace_id": request.workspace_id
}
}
Extract the AI's reply from the JSON response and return it as {"reply": extracted_text}.

4. The Frontend (/extension)
   Build a TypeScript VS Code extension with a React-based Webview sidebar.

Core Architecture:
API Base URL: Hardcode to http://localhost:8000 (the FastAPI server).

Identity: On activation, check context.globalState for a semanticSyncUserId. If it doesn't exist, generate a UUIDv4, save it, and use it as the user_id.

Feature 1: Workspace Indexer
Register command: semanticSync.indexWorkspace.

Get the current root folder name as workspace_id.

Scan the workspace for .md, .ts, .js, .json, .py files.

CRITICAL: Ignore node_modules, .git, .next, dist, build.

Batch files and POST to http://localhost:8000/api/ingest matching the IngestRequest schema.

Show a VS Code Progress Badge in the status bar while indexing.

Feature 2: Incremental Sync
Listen to vscode.workspace.onDidSaveTextDocument.

If the saved file matches allowed extensions and is not ignored, POST it silently to /api/ingest to keep the Agent's context updated.

Feature 3: Sidebar Chat UI
Register a WebviewViewProvider to the Primary Sidebar.

Build a simple HTML/React UI with a message history container, an input box, and a send button.

Use VS Code CSS variables (e.g., var(--vscode-editor-background)) so it matches the user's theme.

Message Flow:

User types message -> hits Send.

Webview sends postMessage to the extension.

Extension makes a POST request to http://localhost:8000/api/chat with user_id, workspace_id, and message.

Extension receives the reply from FastAPI and sends it back to the Webview to display.

Please initialize both directories, write the core files (main.py for backend, extension.ts for frontend), and configure the necessary package.json and requirements.txt files to make this a functional monorepo.
