import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import {
  ensureFirebaseAuthState,
  resolveAuthCallback,
  signOut,
  type FirebaseAuthState,
} from "./auth";
import {
  readGitignore,
  buildIgnoreMatcher,
  DEFAULT_GITIGNORE_CONTENT,
} from "./gitignore";

const API_BASE = "https://semantic-sync-production.up.railway.app";
const INGEST_URL = `${API_BASE}/api/ingest`;
const PRUNE_URL = `${API_BASE}/api/prune-workspace-scope`;
const SUMMARY_URL = `${API_BASE}/api/summarize-workspace`;
const USAGE_URL = `${API_BASE}/api/usage`;
const HASHES_URL = `${API_BASE}/api/workspace-hashes`;

const AUTH_STATE_KEY = "semanticSyncAuthState";
const ALLOWED_EXTENSIONS = new Set([".md", ".ts", ".js", ".json", ".py"]);
const IGNORED_FOLDERS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
]);

export type IndexStatus = {
  status: "idle" | "running" | "done" | "error";
  processed: number;
  total: number;
  message?: string;
  prunedCount?: number;
};

export type UsageInfo = {
  tokens_embedded: number;
  files_embedded: number;
  tier: string;
  limit: number | null;
  limit_reached: boolean;
  last_updated_at?: string;
};

// Cached gitignore matcher — refreshed whenever .gitignore is saved
let cachedIgnoreMatcher: ((relativePath: string) => boolean) | null = null;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Semantic Sync");
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  statusBar.text = "Semantic Sync";
  statusBar.hide();

  output.appendLine("Semantic Sync activated.");

  // URI handler must be registered before any auth flow can complete.
  const uriHandlerDisposable = vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri): void {
      if (uri.path === "/auth-callback") {
        output.appendLine(`Auth callback received.`);
        resolveAuthCallback(uri);
      }
    },
  });

  const authenticateDisposable = vscode.commands.registerCommand(
    "semanticSync.authenticate",
    async () => {
      try {
        const authState = await ensureFirebaseAuthState(context, output);
        vscode.window.showInformationMessage(
          `Semantic Sync signed in. uid=${authState.uid}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
          `Semantic Sync authentication failed: ${message}`,
        );
      }
    },
  );

  let activeIndexRun: Promise<void> | undefined;
  const runIndexWorkspace = async (
    onStatus?: (status: IndexStatus) => void,
  ) => {
    if (activeIndexRun) {
      onStatus?.({
        status: "error",
        processed: 0,
        total: 0,
        message: "Indexing is already running.",
      });
      return;
    }

    activeIndexRun = indexWorkspace(context, output, statusBar, onStatus);
    try {
      await activeIndexRun;
    } finally {
      activeIndexRun = undefined;
    }
  };

  const indexDisposable = vscode.commands.registerCommand(
    "semanticSync.indexWorkspace",
    async () => {
      await runIndexWorkspace();
    },
  );

  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    output,
    runIndexWorkspace,
    async () => {
      const auth = await ensureFirebaseAuthState(context, output);
      return { Authorization: `Bearer ${auth.idToken}` };
    },
    () => {
      const s = context.globalState.get<FirebaseAuthState>(AUTH_STATE_KEY);
      return !!(s?.idToken && s.expiresAt > Date.now() + 60_000);
    },
    async () => {
      await ensureFirebaseAuthState(context, output);
      chatProvider.notifySignedIn();
    },
    async () => {
      const auth = await ensureFirebaseAuthState(context, output);
      return postJson(
        USAGE_URL,
        undefined,
        { Authorization: `Bearer ${auth.idToken}` },
        "GET",
      ) as Promise<UsageInfo>;
    },
    async (entries) => {
      // Restore globalState workspace map from Firestore-backed /api/projects response.
      // Only restores entries whose local_root_path matches a folder open on this machine.
      const stored =
        context.globalState.get<Record<string, WorkspaceEntry>>(
          WORKSPACE_ID_KEY,
        ) ?? {};
      let changed = false;
      for (const entry of entries) {
        if (!entry.local_root_path || !entry.git_remote) {
          continue;
        }
        const rootPath = entry.local_root_path;
        if (!stored[rootPath]) {
          stored[rootPath] = {
            workspaceId: entry.workspace_id,
            gitRemote: entry.git_remote,
            localRootPath: rootPath,
          };
          changed = true;
        }
      }
      if (changed) {
        await context.globalState.update(WORKSPACE_ID_KEY, stored);
      }
    },
    async () => {
      await signOut(context);
    },
    (proj?: string) => {
      const stored =
        context.globalState.get<Record<string, WorkspaceEntry>>(
          WORKSPACE_ID_KEY,
        ) ?? {};
      // If a proj (workspaceId) is provided, find the matching entry by workspaceId
      if (proj) {
        const match = Object.values(stored).find(
          (e) => e.workspaceId === proj,
        );
        if (match) {
          return match.gitRemote;
        }
      }
      // Fall back to the current workspace's git remote
      const folders = vscode.workspace.workspaceFolders;
      const rootPath = folders?.[0]?.uri.fsPath;
      return rootPath ? (stored[rootPath]?.gitRemote ?? null) : null;
    },
    () => {
      const folders = vscode.workspace.workspaceFolders;
      const rootPath = folders?.[0]?.uri.fsPath;
      if (!rootPath) {
        return undefined;
      }
      const stored =
        context.globalState.get<Record<string, WorkspaceEntry>>(
          WORKSPACE_ID_KEY,
        ) ?? {};
      return stored[rootPath]?.workspaceId;
    },
  );
  const chatDisposable = vscode.window.registerWebviewViewProvider(
    "semanticSync.chatView",
    chatProvider,
  );

  const signOutDisposable = vscode.commands.registerCommand(
    "semanticSync.signOut",
    async () => {
      await signOut(context);
      vscode.window.showInformationMessage("Semantic Sync: Signed out.");
      chatProvider.notifySignedOut();
    },
  );

  const saveDisposable = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      const relativePath = vscode.workspace.asRelativePath(document.uri, false);

      // If .gitignore was saved, invalidate the cached matcher
      if (
        relativePath === ".gitignore" ||
        relativePath.endsWith("/.gitignore")
      ) {
        cachedIgnoreMatcher = null;
        output.appendLine(".gitignore changed — cache invalidated.");
      }

      if (!isAllowedDocument(document)) {
        return;
      }
      const rootUri = getWorkspaceRootUri();
      if (!rootUri) {
        return;
      }
      // Silent lookup — if user hasn't confirmed a name yet, skip incremental sync
      const wsEntry = await getOrAskWorkspaceEntry(
        context,
        rootUri,
        /* prompt */ false,
      );
      if (!wsEntry) {
        return;
      }
      const { workspaceId, gitRemote, localRootPath } = wsEntry;

      // Get or build the ignore matcher
      const ignoreMatcher = await getOrBuildIgnoreMatcher(output);
      if (ignoreMatcher === null) {
        // No .gitignore — skip incremental sync silently
        return;
      }
      if (isHardIgnored(relativePath) || ignoreMatcher(relativePath)) {
        return;
      }

      try {
        const auth = await ensureFirebaseAuthState(context, output);
        await postJson(
          INGEST_URL,
          {
            workspace_id: workspaceId,
            files: [{ file_path: relativePath, content: document.getText() }],
            git_remote: gitRemote,
            local_root_path: localRootPath,
          },
          { Authorization: `Bearer ${auth.idToken}` },
        );
        output.appendLine(`Incremental sync: ${relativePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Incremental ingest error: ${message}`);
      }
    },
  );

  context.subscriptions.push(
    output,
    statusBar,
    uriHandlerDisposable,
    authenticateDisposable,
    indexDisposable,
    chatDisposable,
    signOutDisposable,
    saveDisposable,
  );
}

export function deactivate() {
  // no-op
}

async function getOrBuildIgnoreMatcher(
  output: vscode.OutputChannel,
): Promise<((relativePath: string) => boolean) | null> {
  if (cachedIgnoreMatcher !== null) {
    return cachedIgnoreMatcher;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  const lines = await readGitignore(folders[0].uri);
  if (lines === null) {
    return null;
  }
  cachedIgnoreMatcher = buildIgnoreMatcher(lines);
  output.appendLine(".gitignore loaded and cached.");
  return cachedIgnoreMatcher;
}

async function indexWorkspace(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  onStatus?: (status: IndexStatus) => void,
): Promise<void> {
  const rootUri = getWorkspaceRootUri();
  if (!rootUri) {
    vscode.window.showErrorMessage(
      "Semantic Sync: No workspace folder is open.",
    );
    onStatus?.({
      status: "error",
      processed: 0,
      total: 0,
      message: "No workspace folder is open.",
    });
    return;
  }

  const wsEntry = await getOrAskWorkspaceEntry(
    context,
    rootUri,
    /* prompt */ true,
  );
  if (!wsEntry) {
    onStatus?.({
      status: "error",
      processed: 0,
      total: 0,
      message: "Workspace name is required.",
    });
    return;
  }
  const { workspaceId, gitRemote, localRootPath } = wsEntry;

  // Invalidate cache and re-read .gitignore
  cachedIgnoreMatcher = null;
  const lines = await readGitignore(rootUri);

  if (lines === null) {
    // No .gitignore — prompt user to create one
    const choice = await vscode.window.showErrorMessage(
      "Semantic Sync: No .gitignore found. A .gitignore is required to control which files are indexed.",
      "Create .gitignore",
    );
    if (choice === "Create .gitignore") {
      const gitignoreUri = vscode.Uri.joinPath(rootUri, ".gitignore");
      await vscode.workspace.fs.writeFile(
        gitignoreUri,
        Buffer.from(DEFAULT_GITIGNORE_CONTENT, "utf8"),
      );
      await vscode.window.showTextDocument(gitignoreUri);
      vscode.window.showInformationMessage(
        "Semantic Sync: .gitignore created. Review it, then run Index Workspace again.",
      );
    }
    onStatus?.({
      status: "error",
      processed: 0,
      total: 0,
      message: "No .gitignore found. Create one and try again.",
    });
    return;
  }

  const ignoreMatcher = buildIgnoreMatcher(lines);
  cachedIgnoreMatcher = ignoreMatcher;

  let authState: FirebaseAuthState;
  try {
    authState = await ensureFirebaseAuthState(context, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Semantic Sync authentication failed: ${message}`,
    );
    onStatus?.({
      status: "error",
      processed: 0,
      total: 0,
      message: `Auth failed: ${message}`,
    });
    return;
  }

  output.appendLine(
    `Indexing workspace "${workspaceId}" using .gitignore rules...`,
  );

  // Find all files with allowed extensions, filter by .gitignore + hard ignores
  const allUris = await vscode.workspace.findFiles(
    "**/*.{md,ts,js,json,py}",
    null,
  );
  const files = allUris.filter((uri) => {
    const relativePath = vscode.workspace
      .asRelativePath(uri, false)
      .replace(/\\/g, "/");
    return !isHardIgnored(relativePath) && !ignoreMatcher(relativePath);
  });

  const batchSize = 10;
  const indexedFilePaths = files.map((uri) =>
    vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"),
  );
  let processed = 0;
  onStatus?.({
    status: "running",
    processed: 0,
    total: files.length,
    message: "Checking for changes...",
  });
  statusBar.text = "$(sync~spin) Semantic Sync: Indexing...";
  statusBar.show();

  const authHeaders = { Authorization: `Bearer ${authState.idToken}` };

  // Fetch existing content hashes from the backend once, then filter to only
  // changed or new files. This prevents redundant Anthropic summary calls.
  let existingHashes: Record<string, string> = {};
  try {
    const hashResult = (await postJson(
      `${HASHES_URL}?workspace_id=${encodeURIComponent(workspaceId)}`,
      undefined,
      authHeaders,
      "GET",
    )) as { hashes: Record<string, string> };
    if (hashResult?.hashes && typeof hashResult.hashes === "object") {
      existingHashes = hashResult.hashes;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(
      `Hash fetch failed (will re-index all files): ${message}`,
    );
  }

  // Read all files and filter to only those whose content has changed.
  // We read once here to avoid double I/O.
  type FileEntry = { file_path: string; content: string };
  const changedFiles: FileEntry[] = [];
  for (const uri of files) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString("utf8");
    const relativePath = vscode.workspace
      .asRelativePath(uri, false)
      .replace(/\\/g, "/");
    if (md5(content) !== existingHashes[relativePath]) {
      changedFiles.push({ file_path: relativePath, content });
    }
  }

  const skippedCount = files.length - changedFiles.length;
  if (skippedCount > 0) {
    output.appendLine(`Skipping ${skippedCount} unchanged files.`);
  }

  if (changedFiles.length === 0) {
    statusBar.hide();
    output.appendLine("Nothing to index — all files are up to date.");
    vscode.window.showInformationMessage(
      "Semantic Sync: All files are up to date.",
    );
    onStatus?.({
      status: "done",
      processed: 0,
      total: files.length,
      message: `All ${files.length} files are up to date`,
      prunedCount: 0,
    });
    return;
  }

  onStatus?.({
    status: "running",
    processed: 0,
    total: changedFiles.length,
    message:
      skippedCount > 0
        ? `Indexing ${changedFiles.length} changed files (${skippedCount} unchanged)`
        : "Indexing source files",
  });

  for (let i = 0; i < changedFiles.length; i += batchSize) {
    const batchFiles = changedFiles.slice(i, i + batchSize);

    try {
      await postJson(
        INGEST_URL,
        {
          workspace_id: workspaceId,
          files: batchFiles,
          git_remote: gitRemote,
          local_root_path: localRootPath,
        },
        authHeaders,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Ingest error: ${message}`);
      statusBar.hide();
      if (message.startsWith("HTTP 429")) {
        const choice = await vscode.window.showErrorMessage(
          "Semantic Sync: Token limit reached. Upgrade your plan to continue indexing.",
          "Upgrade",
        );
        if (choice === "Upgrade") {
          const upgradeBase = "https://semantic-sync-98f37.web.app/upgrade";
          const upgradeUrl = `${upgradeBase}?token=${encodeURIComponent(authState.idToken)}`;
          vscode.env.openExternal(vscode.Uri.parse(upgradeUrl));
        }
        onStatus?.({
          status: "error",
          processed,
          total: changedFiles.length,
          message: "Token limit reached. Upgrade to continue.",
        });
      } else {
        vscode.window.showErrorMessage(
          `Semantic Sync ingest failed: ${message}`,
        );
        onStatus?.({
          status: "error",
          processed,
          total: changedFiles.length,
          message,
        });
      }
      return;
    }

    processed += batchFiles.length;
    statusBar.text = `$(sync~spin) Semantic Sync: ${processed}/${changedFiles.length}`;
    onStatus?.({
      status: "running",
      processed,
      total: changedFiles.length,
      message: "Indexing source files",
    });
  }

  statusBar.text = "$(sync~spin) Semantic Sync: Pruning stale docs...";
  onStatus?.({
    status: "running",
    processed,
    total: changedFiles.length,
    message: "Pruning stale docs",
  });

  let prunedCount = 0;
  try {
    const pruneResult = await postJson(
      PRUNE_URL,
      {
        workspace_id: workspaceId,
        indexed_file_paths: indexedFilePaths,
      },
      authHeaders,
    );
    if (
      typeof pruneResult === "object" &&
      pruneResult &&
      "deleted" in pruneResult
    ) {
      const deleted = Number((pruneResult as { deleted: unknown }).deleted);
      prunedCount = Number.isFinite(deleted) ? deleted : 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Prune error: ${message}`);
    vscode.window.showErrorMessage(`Semantic Sync prune failed: ${message}`);
    statusBar.hide();
    onStatus?.({
      status: "error",
      processed,
      total: changedFiles.length,
      message: `Prune failed: ${message}`,
    });
    return;
  }

  statusBar.text =
    "$(sync~spin) Semantic Sync: Generating workspace summary...";
  onStatus?.({
    status: "running",
    processed,
    total: changedFiles.length,
    message: "Generating workspace summary",
  });
  try {
    await postJson(SUMMARY_URL, { workspace_id: workspaceId }, authHeaders);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Summary generation error: ${message}`);
    vscode.window.showErrorMessage(
      `Semantic Sync summary generation failed: ${message}`,
    );
    statusBar.hide();
    onStatus?.({
      status: "error",
      processed,
      total: changedFiles.length,
      message: `Summary generation failed: ${message}`,
    });
    return;
  }

  statusBar.hide();
  output.appendLine("Indexing complete. Summary document refreshed.");
  vscode.window.showInformationMessage(
    "Semantic Sync: Workspace indexing and summary complete.",
  );
  onStatus?.({
    status: "done",
    processed,
    total: files.length, // use original count for "X files indexed" display
    message:
      skippedCount > 0
        ? `Updated ${processed} files (${skippedCount} unchanged)`
        : "Workspace summary updated",
    prunedCount,
  });
}

type WorkspaceEntry = {
  workspaceId: string;
  gitRemote: string; // GitHub "owner/repo" slug — required
  localRootPath: string; // absolute path on this machine
};

const WORKSPACE_ID_KEY = "semanticSyncWorkspaceIds"; // globalState key → Record<rootPath, WorkspaceEntry>

/**
 * Read the git remote origin slug ("owner/repo") from .git/config.
 * Returns null if the folder is not a git repo or has no remote origin.
 */
async function readGitRemote(rootUri: vscode.Uri): Promise<string | null> {
  try {
    const gitConfigUri = vscode.Uri.joinPath(rootUri, ".git", "config");
    const bytes = await vscode.workspace.fs.readFile(gitConfigUri);
    const text = Buffer.from(bytes).toString("utf8");
    // Match: url = https://github.com/owner/repo.git  OR  git@github.com:owner/repo.git
    const httpsMatch = text.match(
      /url\s*=\s*https?:\/\/[^/]+\/([^/\s]+\/[^\s.]+?)(?:\.git)?\s*$/m,
    );
    const sshMatch = text.match(
      /url\s*=\s*git@[^:]+:([^/\s]+\/[^\s.]+?)(?:\.git)?\s*$/m,
    );
    const slug = (httpsMatch?.[1] ?? sshMatch?.[1] ?? "").trim();
    return slug && slug.includes("/") ? slug : null;
  } catch {
    return null;
  }
}

/**
 * Get (and confirm) the workspace entry for the current root folder.
 * - Requires a git remote — blocks and shows instructions if missing.
 * - On first index, prompts the user to confirm/rename the workspace ID.
 * - Persists to globalState so incremental saves reuse it silently.
 * Returns undefined if the user cancels or prerequisites aren't met.
 */
async function getOrAskWorkspaceEntry(
  context: vscode.ExtensionContext,
  rootUri: vscode.Uri,
  prompt: boolean,
): Promise<WorkspaceEntry | undefined> {
  const rootPath = rootUri.fsPath;
  const stored =
    context.globalState.get<Record<string, WorkspaceEntry>>(WORKSPACE_ID_KEY) ??
    {};

  // Already confirmed — return cached entry
  if (stored[rootPath]) {
    return stored[rootPath];
  }

  if (!prompt) {
    // Incremental save: no entry yet, skip silently until user runs full index
    return undefined;
  }

  // --- Require a git remote ---
  const gitRemote = await readGitRemote(rootUri);
  if (!gitRemote) {
    const choice = await vscode.window.showErrorMessage(
      "Semantic Sync requires a GitHub remote to uniquely identify this workspace. " +
        "Add a remote origin and try again.",
      "How to add a remote",
    );
    if (choice === "How to add a remote") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          "https://docs.github.com/en/get-started/getting-started-with-git/managing-remote-repositories",
        ),
      );
    }
    return undefined;
  }

  // Pre-fill with the GitHub slug (owner/repo) — clean, unique, semantic
  const chosen = await vscode.window.showInputBox({
    title: "Semantic Sync — Confirm workspace name",
    prompt:
      "Detected from your GitHub remote. Edit if needed — this name identifies the project in your index.",
    value: gitRemote,
    validateInput: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "Name cannot be empty.";
      if (/[^a-zA-Z0-9/_\-.]/.test(trimmed))
        return "Use only letters, numbers, /, _, -, or .";
      return undefined;
    },
  });

  if (!chosen) {
    return undefined; // user cancelled
  }

  const entry: WorkspaceEntry = {
    workspaceId: chosen.trim(),
    gitRemote,
    localRootPath: rootPath,
  };
  stored[rootPath] = entry;
  await context.globalState.update(WORKSPACE_ID_KEY, stored);
  return entry;
}

function getWorkspaceRootUri(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri : undefined;
}

function md5(text: string): string {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function isAllowedDocument(document: vscode.TextDocument): boolean {
  const ext = path.extname(document.fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return false;
  }
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  if (relative.startsWith("..")) {
    return false;
  }
  return true;
}

function isHardIgnored(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").some((part) => IGNORED_FOLDERS.has(part));
}

async function postJson(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
  method: "POST" | "GET" = "POST",
): Promise<unknown> {
  const isGet = method === "GET";
  const response = await fetch(url, {
    method,
    headers: {
      ...(!isGet ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders || {}),
    },
    ...(!isGet ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json")
    ? response.json()
    : response.text();
}
