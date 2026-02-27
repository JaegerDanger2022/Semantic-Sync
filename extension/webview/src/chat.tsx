import React, { useEffect, useRef, useState } from 'react';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type AgentStep = {
  [key: string]: unknown;
};

type IndexStatus = {
  status: 'idle' | 'running' | 'done' | 'error';
  processed: number;
  total: number;
  message?: string;
  prunedCount?: number;
};

type UsageInfo = {
  tokens_embedded: number;
  files_embedded: number;
  tier: string;
  limit: number | null;
  limit_reached: boolean;
  last_updated_at?: string;
};

type VscodeApi = {
  postMessage: (message: unknown) => void;
};

type ChatProps = {
  vscode: VscodeApi;
};

export function Chat({ vscode }: ChatProps) {
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<AgentStep[]>([]);
  const [input, setInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>({
    status: 'idle',
    processed: 0,
    total: 0
  });
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [hasBeenIndexed, setHasBeenIndexed] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [projectScope, setProjectScope] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(true);
  // True from mount until both auth state and usage have been received from the extension.
  // Keeps the index button disabled so a fast click can't fire before we know the user's quota.
  const [isInitialising, setIsInitialising] = useState(true);
  const initialisedRef = useRef({ auth: false, usage: false });

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, [vscode]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'setAuthState') {
        setIsSignedIn(Boolean(message.isSignedIn));
        initialisedRef.current.auth = true;
        if (initialisedRef.current.usage) setIsInitialising(false);
      } else if (message?.type === 'setMessages') {
        setMessages(message.messages || []);
      } else if (message?.type === 'setIndexStatus') {
        setIndexStatus(message.status);
      } else if (message?.type === 'setChatLoading') {
        setIsChatLoading(Boolean(message.isLoading));
        if (!message.isLoading) setChatStatus(null);
      } else if (message?.type === 'setChatStatus') {
        setChatStatus(typeof message.message === 'string' ? message.message : null);
      } else if (message?.type === 'setTrace') {
        setTrace(Array.isArray(message.steps) ? message.steps : []);
      } else if (message?.type === 'setUsage') {
        setUsage(message.usage as UsageInfo);
        initialisedRef.current.usage = true;
        if (initialisedRef.current.auth) setIsInitialising(false);
      } else if (message?.type === 'setProjects') {
        const incoming = Array.isArray(message.projects) ? (message.projects as string[]) : [];
        setProjects(incoming);
        // Auto-select the first project if nothing is selected yet
        if (incoming.length > 0) {
          setActiveProject(prev => prev ?? incoming[0]);
        }
      } else if (message?.type === 'setHasBeenIndexed') {
        setHasBeenIndexed(Boolean(message.hasBeenIndexed));
      } else if (message?.type === 'setProjectScope') {
        setProjectScope(typeof message.label === 'string' ? message.label : null);
        setTraceOpen(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const send = () => {
    const text = input.trim();
    if (!text || isChatLoading) {
      return;
    }
    vscode.postMessage({ type: 'sendMessage', text });
    setInput('');
  };

  const startIndex = () => {
    if (indexStatus.status === 'running') {
      return;
    }
    setIndexStatus(s => ({ ...s, status: 'running', processed: 0, message: 'Starting...' }));
    vscode.postMessage({ type: 'indexWorkspace' });
  };

  // Mark as indexed once a full index completes
  useEffect(() => {
    if (indexStatus.status === 'done') {
      setHasBeenIndexed(true);
    }
  }, [indexStatus.status]);

  // Auto-hide the hint after 4s when it's the verbose "incremental sync" message
  useEffect(() => {
    if (!hasBeenIndexed) { setShowHint(true); return; }
    setShowHint(true);
    const t = setTimeout(() => setShowHint(false), 4000);
    return () => clearTimeout(t);
  }, [hasBeenIndexed]);

  const handleProjectChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    const project = value === '' ? null : value;
    setActiveProject(project);
    vscode.postMessage({ type: 'filterProject', project });
  };

  const getStatusLabel = () => {
    if (indexStatus.message) {
      if (indexStatus.status === 'running') {
        return `${indexStatus.message} (${indexStatus.processed}/${indexStatus.total})`;
      }
      return indexStatus.message;
    }
    if (indexStatus.status === 'running') {
      return `Indexing ${indexStatus.processed}/${indexStatus.total}`;
    }
    if (indexStatus.status === 'done') {
      return `Indexed ${indexStatus.processed} files`;
    }
    if (indexStatus.status === 'error') {
      return indexStatus.message || 'Indexing failed';
    }
    return 'Ready to index';
  };

  if (isSignedIn === null) {
    return (
      <div style={{ padding: 16, color: 'var(--vscode-descriptionForeground)' }}>Loading...</div>
    );
  }

  if (!isSignedIn) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, padding: '32px 20px', textAlign: 'center'
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--vscode-foreground)' }}>
          Sign in to Semantic Sync
        </div>
        <div style={{
          fontSize: 13, color: 'var(--vscode-descriptionForeground)',
          maxWidth: 260, lineHeight: 1.5
        }}>
          Sign in with your GitHub account to index your workspace and chat with your codebase.
        </div>
        <button
          className="index-button"
          onClick={() => vscode.postMessage({ type: 'signInWithGitHub' })}
        >
          Sign in with GitHub
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="index-panel">
        <div className="index-panel-header">
          <div className="index-label">{hasBeenIndexed ? 'Re-index Workspace' : 'Index Workspace'}</div>
          <button
            className="sign-out-button"
            onClick={() => vscode.postMessage({ type: 'signOut' })}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
        {showHint && (
          <div className={`index-hint${hasBeenIndexed ? ' index-hint-fade' : ''}`}>
            {hasBeenIndexed
              ? 'Incremental sync active — saves are indexed automatically. Re-index to pick up new/deleted files or .gitignore changes.'
              : 'Uses your .gitignore to determine which files to index.'}
          </div>
        )}
        {usage && <UsageBar usage={usage} />}
        <button
          className="index-button"
          onClick={startIndex}
          disabled={isInitialising || indexStatus.status === 'running'}
        >
          {isInitialising ? 'Loading...' : indexStatus.status === 'running' ? 'Indexing...' : hasBeenIndexed ? 'Re-index Workspace' : 'Index Workspace'}
        </button>
        <div className={`index-status ${indexStatus.status}`}>{getStatusLabel()}</div>
        {typeof indexStatus.prunedCount === 'number' && indexStatus.status === 'done' && (
          <div className="index-status">Pruned {indexStatus.prunedCount} stale docs this run.</div>
        )}
      </div>
      <div className="messages">
        {messages.length === 0 && !isChatLoading && (
          <div className="empty-hint">
            Ask anything about {projectScope ?? 'your codebase'}.
          </div>
        )}
        {messages.map((msg, idx) => {
          const isStreamingThis = isChatLoading && msg.role === 'assistant' && idx === messages.length - 1;
          if (msg.role === 'assistant') {
            return (
              <div key={`${msg.role}-${idx}`} className="message assistant">
                <div
                  className="md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                  onClick={(e) => {
                    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-file]');
                    if (btn) {
                      vscode.postMessage({ type: 'openFile', proj: btn.dataset.proj, file: btn.dataset.file });
                    }
                  }}
                />
                {isStreamingThis && <span className="stream-cursor" />}
              </div>
            );
          }
          return (
            <div key={`${msg.role}-${idx}`} className="message user">
              {msg.content}
            </div>
          );
        })}
        {isChatLoading && !(messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.content) && (
          <div className="loader">
            <div className="loader-dots">
              <span />
              <span />
              <span />
            </div>
            <span>{chatStatus ?? 'Agent is working...'}</span>
          </div>
        )}
        {trace.length > 0 && (
          <div className="trace-panel">
            <button
              className="trace-toggle"
              onClick={() => setTraceOpen(o => !o)}
              aria-expanded={traceOpen}
            >
              <span className={`trace-chevron ${traceOpen ? 'open' : ''}`}>›</span>
              Agent Trace
              <span className="trace-count">{trace.length} step{trace.length !== 1 ? 's' : ''}</span>
            </button>
            {traceOpen && trace.map((step, idx) => (
              <div className="trace-step" key={`trace-${idx}`}>
                {formatStep(step, idx)}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="composer">
        {projects.length > 0 && (
          <select
            className="project-filter-select"
            value={activeProject ?? projects[0]}
            onChange={handleProjectChange}
            title="Scope chat to a specific project"
          >
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
        <div className="composer-row">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={isChatLoading}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="Ask about your code..."
          />
          <button onClick={send} disabled={isChatLoading}>
            {isChatLoading ? 'Working...' : 'Send'}
          </button>
        </div>
      </div>
    </>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeBuf: string[] = [];

  const flushList = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  const flushCode = () => {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
    codeBuf = [];
    inCode = false;
  };

  // inlineFormat receives RAW (unescaped) text and returns safe HTML
  const inlineFormat = (raw: string): string => {
    // Tokenise by splitting on patterns we care about, escape everything else
    // Order matters: citations first, then bold, then italic, then code
    const TOKEN = /(\[Project:\s*[^\]|]+\s*\|\s*File:\s*[^\]]+\]|\*\*[^*]+\*\*|(?<!\*)\*(?!\*)[^*]+(?<!\*)\*(?!\*)|`[^`]+`)/g;
    const parts = raw.split(TOKEN);
    return parts.map((part) => {
      // Citation: [Project: X | File: Y]
      const cite = part.match(/^\[Project:\s*([^\]|]+)\s*\|\s*File:\s*([^\]]+)\]$/);
      if (cite) {
        const proj = escapeHtml(cite[1].trim());
        const file = escapeHtml(cite[2].trim());
        return `<button class="citation" data-proj="${proj}" data-file="${file}" title="Open ${file}"><span class="citation-proj">${proj}</span><span class="citation-sep">›</span><span class="citation-file">${file}</span></button>`;
      }
      // Bold **text**
      const bold = part.match(/^\*\*([^*]+)\*\*$/);
      if (bold) return `<strong>${escapeHtml(bold[1])}</strong>`;
      // Italic *text*
      const italic = part.match(/^\*([^*]+)\*$/);
      if (italic) return `<em>${escapeHtml(italic[1])}</em>`;
      // Inline code `text`
      const code = part.match(/^`([^`]+)`$/);
      if (code) return `<code>${escapeHtml(code[1])}</code>`;
      // Plain text — escape HTML
      return escapeHtml(part);
    }).join('');
  };

  for (const raw of lines) {
    // Fenced code block toggle
    if (raw.trimStart().startsWith('```')) {
      if (inCode) {
        flushCode();
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    // Headings
    const h3 = raw.match(/^###\s+(.*)/);
    const h2 = raw.match(/^##\s+(.*)/);
    const h1 = raw.match(/^#\s+(.*)/);
    if (h1 || h2 || h3) {
      flushList();
      const level = h1 ? 1 : h2 ? 2 : 3;
      const content = (h1 ?? h2 ?? h3)![1];
      out.push(`<h${level + 2} class="md-h">${inlineFormat(content)}</h${level + 2}>`);
      continue;
    }

    // Unordered list item
    const ulMatch = raw.match(/^(\s*)[*\-]\s+(.*)/);
    if (ulMatch) {
      if (!inUl) { if (inOl) { out.push('</ol>'); inOl = false; } out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list item
    const olMatch = raw.match(/^\s*\d+\.\s+(.*)/);
    if (olMatch) {
      if (!inOl) { if (inUl) { out.push('</ul>'); inUl = false; } out.push('<ol>'); inOl = true; }
      out.push(`<li>${inlineFormat(olMatch[1])}</li>`);
      continue;
    }

    flushList();

    // Blank line → paragraph break
    if (raw.trim() === '') {
      out.push('<br>');
      continue;
    }

    out.push(`<p>${inlineFormat(raw)}</p>`);
  }

  if (inCode) flushCode();
  flushList();

  return out.join('');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function UsageBar({ usage }: { usage: UsageInfo }) {
  const { tokens_embedded, limit, tier, limit_reached } = usage;
  const pct = limit ? Math.min(100, (tokens_embedded / limit) * 100) : 0;
  const fillClass = limit_reached
    ? 'usage-bar-fill at-limit'
    : pct >= 80
    ? 'usage-bar-fill near-limit'
    : 'usage-bar-fill';

  return (
    <div className="usage-bar-wrap">
      <div className="usage-bar-row">
        <span>
          {formatTokens(tokens_embedded)}{limit ? ` / ${formatTokens(limit)}` : ''} tokens
        </span>
        <span className="usage-tier">{tier}</span>
      </div>
      {limit !== null && (
        <div className="usage-bar-track">
          <div className={fillClass} style={{ width: `${pct}%` }} />
        </div>
      )}
      {limit_reached && (
        <div className="index-status error">Token limit reached. Upgrade to continue indexing.</div>
      )}
    </div>
  );
}

function formatStep(step: AgentStep, index: number): string {
  const title = asText(step.name) || asText(step.type) || `Step ${index + 1}`;
  const status = asText(step.status);
  const rawSummary = asText(step.summary) || asText(step.message) || asText(step.description);
  const summary = rawSummary ? truncate(rawSummary, 160) : undefined;
  const bits = [title];
  if (status) {
    bits.push(`(${status})`);
  }
  if (summary) {
    bits.push(`— ${summary}`);
  }
  if (bits.length > 1 || summary) {
    return bits.join(' ');
  }
  return truncate(safeJson(step), 200);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
