import * as vscode from 'vscode';
import type { IndexStatus, UsageInfo } from './extension';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type AgentStep = {
  [key: string]: unknown;
};

type ChatResponse = {
  reply?: string;
  steps?: AgentStep[];
};

const API_BASE = 'http://localhost:8000';
const CHAT_URL = `${API_BASE}/api/chat`;
const CHAT_STREAM_URL = `${API_BASE}/api/chat/stream`;
const PROJECTS_URL = `${API_BASE}/api/projects`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private indexStatus: IndexStatus = { status: 'idle', processed: 0, total: 0 };
  private isChatLoading = false;
  private activeProject: string | null = null;
  private projects: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly requestIndexWorkspace: (
      onStatus?: (status: IndexStatus) => void
    ) => Promise<void>,
    private readonly getAuthHeaders: () => Promise<Record<string, string>>,
    private readonly isAuthenticated: () => boolean,
    private readonly triggerAuth: () => Promise<void>,
    private readonly fetchUsage: () => Promise<UsageInfo>,
    /** Called with project entries from /api/projects so globalState can be restored */
    private readonly restoreWorkspaceEntries: (
      entries: Array<{ workspace_id: string; git_remote?: string; local_root_path?: string }>
    ) => Promise<void>,
    private readonly doSignOut: () => Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        return;
      }
      this.postMessages();
      this.postIndexStatus(this.indexStatus);
      this.postChatLoading(this.isChatLoading);
      this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: this.isAuthenticated() });
      void this.refreshUsage();
      void this.refreshProjects();
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        this.postMessages();
        this.postIndexStatus(this.indexStatus);
        this.postChatLoading(this.isChatLoading);
        this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: this.isAuthenticated() });
        void this.refreshUsage();
        void this.refreshProjects();
        return;
      }
      if (message?.type === 'sendMessage') {
        const content = String(message.text || '').trim();
        if (!content) {
          return;
        }
        await this.handleUserMessage(content);
        return;
      }
      if (message?.type === 'indexWorkspace') {
        await this.requestIndexWorkspace((status) => {
          this.indexStatus = status;
          this.postIndexStatus(status);
        });
        // Refresh usage and project list after indexing completes
        void this.refreshUsage();
        void this.refreshProjects();
        return;
      }
      if (message?.type === 'signInWithGitHub') {
        try {
          await this.triggerAuth();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Semantic Sync sign-in failed: ${msg}`);
          this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: false });
        }
        return;
      }
      if (message?.type === 'signOut') {
        await this.doSignOut();
        this.messages = [];
        this.projects = [];
        this.activeProject = null;
        this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: false });
        this.view?.webview.postMessage({ type: 'setUsage', usage: null });
        this.view?.webview.postMessage({ type: 'setProjects', projects: [] });
        return;
      }
      if (message?.type === 'filterProject') {
        const newProject = typeof message.project === 'string' ? message.project : null;
        if (newProject !== this.activeProject) {
          this.activeProject = newProject;
          // Clear history so the agent context is fresh for the new scope
          this.messages = [];
          this.postMessages();
          this.postTrace([]);
          const label = newProject ?? 'All projects';
          this.view?.webview.postMessage({ type: 'setProjectScope', label });
        }
        return;
      }
    });
  }

  public notifySignedIn(): void {
    this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: true });
    // Restore globalState workspace entries from Firestore immediately after sign-in
    // so the user isn't re-prompted for workspace names they've already confirmed.
    void this.refreshUsage();
    void this.refreshProjects();
  }

  public notifySignedOut(): void {
    this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: false });
  }

  private async handleUserMessage(content: string): Promise<void> {
    const workspaceId = this.getWorkspaceId();
    if (!workspaceId) {
      vscode.window.showErrorMessage('Semantic Sync: No workspace folder is open.');
      return;
    }

    this.messages.push({ role: 'user', content });
    this.postMessages();
    this.postTrace([]);
    this.isChatLoading = true;
    this.postChatLoading(true);

    try {
      const authHeaders = await this.getAuthHeaders();
      await this.handleStreamingChat(workspaceId, content, authHeaders);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Chat error: ${message}`);
      vscode.window.showErrorMessage(`Semantic Sync chat failed: ${message}`);
    } finally {
      this.isChatLoading = false;
      this.postChatLoading(false);
    }
  }

  private async handleStreamingChat(
    workspaceId: string,
    content: string,
    authHeaders: Record<string, string>
  ): Promise<void> {
    const response = await fetch(CHAT_STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        workspace_id: workspaceId,
        message: content,
        ...(this.activeProject ? { project_filter: this.activeProject } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('No response body from stream endpoint');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamingReply = '';

    // Add a placeholder assistant message that we'll update as chunks arrive
    this.messages.push({ role: 'assistant', content: '' });
    const replyIndex = this.messages.length - 1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) { continue; }
        const raw = line.slice(6).trim();
        if (!raw) { continue; }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = event.type as string;

        if (type === 'status') {
          // Forward the thinking indicator to the webview
          this.view?.webview.postMessage({ type: 'setChatStatus', message: event.message });
        } else if (type === 'steps') {
          this.postTrace(Array.isArray(event.steps) ? event.steps as AgentStep[] : []);
        } else if (type === 'chunk') {
          // Append chunk to the in-progress assistant message for typewriter effect
          streamingReply += event.text as string;
          this.messages[replyIndex] = { role: 'assistant', content: streamingReply };
          this.postMessages();
        } else if (type === 'reply') {
          // Final full reply — authoritative text, overwrite chunks in case of any gap
          this.messages[replyIndex] = { role: 'assistant', content: event.text as string };
          this.postMessages();
        } else if (type === 'error') {
          const errMsg = (event.message as string) || 'Unknown error';
          this.output.appendLine(`Chat stream error: ${errMsg}`);
          this.messages[replyIndex] = { role: 'assistant', content: `Error: ${errMsg}` };
          this.postMessages();
        } else if (type === 'done') {
          // Clear the thinking indicator
          this.view?.webview.postMessage({ type: 'setChatStatus', message: null });
        }
      }
    }
  }

  private postMessages(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'setMessages', messages: this.messages });
  }

  private postIndexStatus(status: IndexStatus): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'setIndexStatus', status });
  }

  private postChatLoading(isLoading: boolean): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'setChatLoading', isLoading });
  }

  private postTrace(steps: AgentStep[]): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'setTrace', steps });
  }

  private async refreshUsage(): Promise<void> {
    if (!this.isAuthenticated()) {
      // Not signed in — still resolve isInitialising so the webview doesn't hang on "Loading..."
      this.view?.webview.postMessage({ type: 'setUsage', usage: null });
      return;
    }
    try {
      const usage = await this.fetchUsage();
      this.view?.webview.postMessage({ type: 'setUsage', usage });
    } catch (err) {
      // Always send setUsage (even null) so isInitialising clears in the webview.
      this.view?.webview.postMessage({ type: 'setUsage', usage: null });
      // If the error is an auth failure (stale token / deleted account), clear globalState
      // and drop to sign-in screen — prevents an infinite "Loading..." on next reload.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403') || msg.includes('Invalid Firebase token')) {
        void this.doSignOut();
        this.view?.webview.postMessage({ type: 'setAuthState', isSignedIn: false });
      }
    }
  }

  private async refreshProjects(): Promise<void> {
    if (!this.isAuthenticated()) {
      return;
    }
    try {
      const authHeaders = await this.getAuthHeaders();
      const result = await postJson(PROJECTS_URL, undefined, authHeaders, 'GET') as {
        projects: Array<{ workspace_id: string; git_remote?: string; local_root_path?: string; last_ingest_at?: string }>
      };
      if (result && Array.isArray(result.projects)) {
        // Restore globalState so this machine doesn't re-prompt for known workspaces
        void this.restoreWorkspaceEntries(result.projects);
        // Extract just the IDs for the dropdown
        this.projects = result.projects.map((p) => p.workspace_id);
        this.view?.webview.postMessage({ type: 'setProjects', projects: this.projects });
        // Check if the currently open workspace has been indexed before (even on another machine).
        // Match by local_root_path (same machine) — cross-machine match isn't possible without
        // knowing the remote slug here, so we rely on same-machine path match.
        const folders = vscode.workspace.workspaceFolders;
        const currentRootPath = folders?.[0]?.uri.fsPath;
        const hasBeenIndexed = result.projects.some(
          (p) => !!p.last_ingest_at && p.local_root_path === currentRootPath
        );
        this.view?.webview.postMessage({ type: 'setHasBeenIndexed', hasBeenIndexed });
      }
    } catch {
      // Non-critical — swallow errors silently
    }
  }

  private getWorkspaceId(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return folders[0].name;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js')
    );

    const csp = [
      `default-src 'none';`,
      `img-src ${webview.cspSource} https:;`,
      `style-src ${webview.cspSource} 'unsafe-inline';`,
      `script-src 'nonce-${nonce}';`
    ].join(' ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Semantic Sync Chat</title>
  <style>
    :root {
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    body {
      margin: 0;
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    #root {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .index-panel {
      padding: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .index-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .index-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .sign-out-button {
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      cursor: pointer;
      opacity: 0.7;
    }
    .sign-out-button:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .index-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }
    .project-filter-select {
      width: 100%;
      padding: 5px 6px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 12px;
      cursor: pointer;
    }
    .usage-bar-wrap {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .usage-bar-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .usage-bar-track {
      height: 4px;
      border-radius: 2px;
      background: var(--vscode-input-border);
      overflow: hidden;
    }
    .usage-bar-fill {
      height: 100%;
      border-radius: 2px;
      background: var(--vscode-button-background);
      transition: width 0.3s ease;
    }
    .usage-bar-fill.near-limit {
      background: var(--vscode-editorWarning-foreground, #e5a000);
    }
    .usage-bar-fill.at-limit {
      background: var(--vscode-errorForeground, #f14c4c);
    }
    .usage-tier {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .index-button {
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    .index-button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .index-button:disabled {
      opacity: 0.7;
      cursor: default;
    }
    .index-status {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .index-status.error {
      color: var(--vscode-errorForeground);
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .scope-banner {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 4px 8px;
      text-align: center;
    }
    .empty-hint {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      text-align: center;
      margin-top: 24px;
    }
    .message {
      padding: 10px 12px;
      border-radius: 8px;
      max-width: 90%;
    }
    .message.user { white-space: pre-wrap; }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-sideBarSectionHeader-background);
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .md { line-height: 1.55; }
    .md p { margin: 0 0 6px 0; }
    .md p:last-child { margin-bottom: 0; }
    .md br { display: block; margin: 3px 0; content: ''; }
    .md h3, .md h4, .md h5 {
      margin: 8px 0 4px 0;
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }
    .md ul, .md ol {
      margin: 4px 0 6px 0;
      padding-left: 18px;
    }
    .md li { margin: 2px 0; }
    .md code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      border-radius: 3px;
      padding: 1px 4px;
    }
    .md pre {
      margin: 6px 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      overflow-x: auto;
    }
    .md pre code {
      background: none;
      padding: 0;
      font-size: 11px;
    }
    .citation {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 5px;
      vertical-align: middle;
      line-height: 1.4;
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .citation-proj { font-weight: 600; opacity: 0.85; }
    .citation-sep { opacity: 0.5; margin: 0 1px; }
    .citation-file { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.9; }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .composer-row {
      display: flex;
      gap: 8px;
    }
    .composer input {
      flex: 1;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    .composer button {
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    .composer button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .composer button:disabled {
      opacity: 0.7;
      cursor: default;
    }
    .loader {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 12px 10px 12px;
      padding: 8px 10px;
      border-radius: 8px;
      max-width: 90%;
      background: var(--vscode-sideBarSectionHeader-background);
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .loader-dots {
      display: inline-flex;
      gap: 3px;
    }
    .loader-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--vscode-foreground);
      opacity: 0.35;
      animation: pulse 1.2s infinite ease-in-out;
    }
    .loader-dots span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .loader-dots span:nth-child(3) {
      animation-delay: 0.4s;
    }
    .trace-panel {
      margin: 0 12px 10px 12px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      font-size: 12px;
    }
    .trace-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      width: 100%;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 600;
      text-align: left;
    }
    .trace-toggle:hover {
      color: var(--vscode-textLink-foreground);
    }
    .trace-chevron {
      display: inline-block;
      font-size: 14px;
      line-height: 1;
      transition: transform 0.15s ease;
      transform: rotate(0deg);
    }
    .trace-chevron.open {
      transform: rotate(90deg);
    }
    .trace-count {
      margin-left: auto;
      font-weight: 400;
      opacity: 0.6;
      font-size: 11px;
    }
    .trace-step {
      padding: 6px 0;
      border-top: 1px solid var(--vscode-panel-border);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .trace-step:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    @keyframes pulse {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.9); }
      40% { opacity: 1; transform: scale(1); }
    }
    .stream-cursor {
      display: inline-block;
      width: 2px;
      height: 1em;
      background: var(--vscode-foreground);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 0.8s step-end infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function postJson(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
  method: 'POST' | 'GET' = 'POST'
): Promise<unknown> {
  const isGet = method === 'GET';
  const response = await fetch(url, {
    method,
    headers: {
      ...(!isGet ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {})
    },
    ...(!isGet ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : response.text();
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
