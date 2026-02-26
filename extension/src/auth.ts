import * as vscode from 'vscode';

// ── Types ──────────────────────────────────────────────────────────────────

export type FirebaseAuthState = {
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
};

const AUTH_STATE_KEY = 'semanticSyncAuthState';
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes for user to complete GitHub login

// Injected at build time via esbuild --define, or set directly for local dev.
// This is NOT a secret — Firebase Web API keys are designed to be public.
// See: https://firebase.google.com/docs/projects/api-keys#api-keys-for-firebase-are-different
declare const __FIREBASE_API_KEY__: string;
const FIREBASE_API_KEY = typeof __FIREBASE_API_KEY__ !== 'undefined' ? __FIREBASE_API_KEY__ : '';
const CONTINUE_URI_BASE = 'https://semantic-sync-98f37.web.app/auth-callback';

// ── Pending auth: bridges the async gap between browser-open and URI callback ─

type PendingAuth = {
  sessionId: string;
  resolve: (uri: vscode.Uri) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Module-level singletons — only one auth flow can be in-flight at a time.
let pendingAuth: PendingAuth | undefined;
let authInFlight: Promise<FirebaseAuthState> | undefined;

// ── Public: called from the URI handler in extension.ts ───────────────────

/**
 * Called when VS Code receives vscode://semantic-sync.semantic-sync/auth-callback
 * Resolves the pending auth promise so doSignInWithGitHub() can proceed.
 */
export function resolveAuthCallback(uri: vscode.Uri): void {
  if (!pendingAuth) {
    return; // Stale callback (timeout already fired, or double-click)
  }
  const { resolve, timer } = pendingAuth;
  clearTimeout(timer);
  pendingAuth = undefined;
  resolve(uri);
}

// ── Public: main entry point called before every API request ──────────────

export async function ensureFirebaseAuthState(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<FirebaseAuthState> {
  const apiKey = FIREBASE_API_KEY;

  const current = context.globalState.get<FirebaseAuthState>(AUTH_STATE_KEY);
  const now = Date.now();

  // Fast path: token is still valid (with 60-second buffer).
  if (current?.idToken && current.expiresAt > now + 60_000) {
    return current;
  }

  let next: FirebaseAuthState;

  if (current?.refreshToken) {
    try {
      next = await refreshFirebaseToken(apiKey, current.refreshToken);
      output.appendLine(`Firebase token refreshed. uid=${next.uid}`);
    } catch (refreshError) {
      // Refresh token revoked — clear stale state and re-authenticate.
      const msg = refreshError instanceof Error ? refreshError.message : String(refreshError);
      output.appendLine(`Token refresh failed (${msg}). Re-authenticating.`);
      await context.globalState.update(AUTH_STATE_KEY, undefined);
      next = await signInWithGitHub(context, apiKey, output);
    }
  } else {
    next = await signInWithGitHub(context, apiKey, output);
  }

  await context.globalState.update(AUTH_STATE_KEY, next);
  return next;
}

// ── Public: sign-out ───────────────────────────────────────────────────────

export async function signOut(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(AUTH_STATE_KEY, undefined);
  if (pendingAuth) {
    clearTimeout(pendingAuth.timer);
    pendingAuth.reject(new Error('Signed out during pending auth.'));
    pendingAuth = undefined;
  }
}

// ── GitHub OAuth sign-in ───────────────────────────────────────────────────

/**
 * Guard wrapper: ensures only one auth flow runs at a time.
 * Concurrent callers share the same in-flight promise.
 */
async function signInWithGitHub(
  context: vscode.ExtensionContext,
  apiKey: string,
  output: vscode.OutputChannel
): Promise<FirebaseAuthState> {
  if (authInFlight) {
    return authInFlight;
  }
  authInFlight = doSignInWithGitHub(context, apiKey, output).finally(() => {
    authInFlight = undefined;
  });
  return authInFlight;
}

async function doSignInWithGitHub(
  context: vscode.ExtensionContext,
  apiKey: string,
  output: vscode.OutputChannel
): Promise<FirebaseAuthState> {
  // Step 1: Create auth URI — Firebase returns the GitHub OAuth URL + a sessionId.
  const continueUri = CONTINUE_URI_BASE;

  const createAuthUriUrl = `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${encodeURIComponent(apiKey)}`;
  const createResponse = await fetch(createAuthUriUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'github.com', continueUri })
  });

  if (!createResponse.ok) {
    throw new Error(
      `Firebase createAuthUri failed: HTTP ${createResponse.status} ${await createResponse.text()}`
    );
  }

  const createData = (await createResponse.json()) as { authUri: string; sessionId: string };
  const { authUri, sessionId } = createData;
  output.appendLine(`DEBUG authUri: ${authUri}`);

  // Step 2: Set up the pending promise BEFORE opening the browser.
  if (pendingAuth) {
    clearTimeout(pendingAuth.timer);
    pendingAuth.reject(new Error('New auth flow started.'));
    pendingAuth = undefined;
  }

  const callbackUriPromise = new Promise<vscode.Uri>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAuth = undefined;
      reject(new Error('GitHub sign-in timed out. Please try again.'));
    }, AUTH_TIMEOUT_MS);
    pendingAuth = { sessionId, resolve, reject, timer };
  });

  // Step 3: Open browser.
  output.appendLine('Opening GitHub OAuth in browser...');
  await vscode.env.openExternal(vscode.Uri.parse(authUri));

  // Show a notification with a Cancel escape hatch.
  void vscode.window.showInformationMessage(
    'Semantic Sync: A browser window has opened for GitHub sign-in. Complete sign-in there, then return here.',
    'Cancel'
  ).then((choice) => {
    if (choice === 'Cancel' && pendingAuth) {
      clearTimeout(pendingAuth.timer);
      pendingAuth.reject(new Error('Sign-in cancelled by user.'));
      pendingAuth = undefined;
    }
  });

  // Step 4: Wait for the URI handler to call resolveAuthCallback().
  const callbackUri = await callbackUriPromise;

  // Step 5: Complete sign-in with Firebase using the callback URI + sessionId.
  // Firebase signInWithIdp requires an HTTPS requestUri, so reconstruct it from
  // the query params VS Code received (code + state) against the continueUri base.
  const callbackParams = callbackUri.query; // e.g. "code=xxx&state=yyy"
  const requestUri = `${CONTINUE_URI_BASE}?${callbackParams}`;
  output.appendLine(`DEBUG requestUri: ${requestUri}`);

  const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(apiKey)}`;
  const signInResponse = await fetch(signInUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestUri,
      sessionId,
      returnSecureToken: true
    })
  });

  if (!signInResponse.ok) {
    throw new Error(
      `Firebase signInWithIdp failed: HTTP ${signInResponse.status} ${await signInResponse.text()}`
    );
  }

  const signInData = (await signInResponse.json()) as {
    idToken: string;
    refreshToken: string;
    localId: string;
    expiresIn: string;
  };

  output.appendLine(`GitHub sign-in complete. uid=${signInData.localId}`);

  return {
    uid: signInData.localId,
    idToken: signInData.idToken,
    refreshToken: signInData.refreshToken,
    expiresAt: Date.now() + Number(signInData.expiresIn) * 1000
  };
}

// ── Token refresh (logic unchanged from original extension.ts) ─────────────

async function refreshFirebaseToken(apiKey: string, refreshToken: string): Promise<FirebaseAuthState> {
  const url = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  if (!response.ok) {
    throw new Error(
      `Firebase token refresh failed: HTTP ${response.status} ${await response.text()}`
    );
  }
  const data = (await response.json()) as {
    id_token: string;
    refresh_token: string;
    user_id: string;
    expires_in: string;
  };
  return {
    uid: data.user_id,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000
  };
}

