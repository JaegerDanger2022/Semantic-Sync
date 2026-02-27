from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Dict, List, Optional

import asyncio
import hashlib

import anthropic as anthropic_sdk
import httpx
from dotenv import load_dotenv
from elasticsearch import Elasticsearch
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()

ELASTIC_URL = os.getenv("ELASTIC_URL")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
KIBANA_URL = os.getenv("KIBANA_URL")
AGENT_ID = os.getenv("AGENT_ID")
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
FIREBASE_SERVICE_ACCOUNT_JSON = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")  # JSON string for Railway

INDEX_NAME = "semantic-sync-data"
SUMMARY_DOC_PATH = "__workspace_summary__.md"
SUMMARY_DOC_TYPE = "workspace_summary"
SOURCE_DOC_TYPE = "source_file"

# ---------------------------------------------------------------------------
# Subscription tiers — token limits (approximate, chars/4)
# Set a tier's limit to None to mean unlimited.
# ---------------------------------------------------------------------------
SUBSCRIPTION_LIMITS: Dict[str, Optional[int]] = {
    "free": 500_000,       # ~500k tokens
    "pro": 5_000_000,      # ~5M tokens
    "enterprise": None,    # unlimited
}
DEFAULT_TIER = "free"


app = FastAPI(title="Semantic Sync API")

try:
    import firebase_admin
    from firebase_admin import auth as firebase_auth
    from firebase_admin import credentials
    from firebase_admin import firestore
except Exception:
    firebase_admin = None
    firebase_auth = None
    credentials = None
    firestore = None


class FileItem(BaseModel):
    file_path: str
    content: str


class IngestRequest(BaseModel):
    workspace_id: str
    files: List[FileItem]
    git_remote: Optional[str] = None       # e.g. "mkmen/relay-backend"
    local_root_path: Optional[str] = None  # absolute path on the client machine


class ChatRequest(BaseModel):
    workspace_id: str
    message: str


class SummarizeRequest(BaseModel):
    workspace_id: str


class PruneRequest(BaseModel):
    workspace_id: str
    indexed_file_paths: List[str]


class AuthContext(BaseModel):
    uid: str


def get_es_client() -> Elasticsearch:
    if not ELASTIC_URL or not ELASTIC_API_KEY:
        raise RuntimeError("Missing ELASTIC_URL or ELASTIC_API_KEY")
    return Elasticsearch(ELASTIC_URL, api_key=ELASTIC_API_KEY)


@lru_cache(maxsize=1)
def get_firebase_app():
    if firebase_admin is None:
        raise RuntimeError("firebase-admin is not installed. Add it to requirements and install dependencies.")
    if firebase_admin._apps:
        return firebase_admin.get_app()
    # Railway: load service account from JSON env var (takes priority over file path)
    if FIREBASE_SERVICE_ACCOUNT_JSON:
        import json as _json
        service_account_info = _json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)
        cred = credentials.Certificate(service_account_info)
    else:
        # Local dev: use GOOGLE_APPLICATION_CREDENTIALS file path
        cred = credentials.ApplicationDefault()
    if FIREBASE_PROJECT_ID:
        return firebase_admin.initialize_app(cred, {"projectId": FIREBASE_PROJECT_ID})
    return firebase_admin.initialize_app(cred)


def get_firestore_client():
    if firestore is None:
        return None
    try:
        get_firebase_app()
        return firestore.client()
    except Exception:
        return None


def parse_bearer_token(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    parts = authorization.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization header must be Bearer token")
    return parts[1]


def require_auth_context(authorization: Optional[str] = Header(default=None)) -> AuthContext:
    token = parse_bearer_token(authorization)
    if firebase_auth is None:
        raise HTTPException(status_code=500, detail="firebase-admin not installed on backend")
    try:
        get_firebase_app()
        decoded = firebase_auth.verify_id_token(token)
    except Exception as exc:
        import logging
        logging.error("Firebase token verification failed: %s | token_prefix=%s", exc, token[:20] if token else "")
        raise HTTPException(status_code=401, detail=f"Invalid Firebase token: {exc}") from exc
    uid = decoded.get("uid")
    if not isinstance(uid, str) or not uid:
        raise HTTPException(status_code=401, detail="Token missing uid")
    return AuthContext(uid=uid)


# ---------------------------------------------------------------------------
# Token counting helpers
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """Fast approximation: 1 token ≈ 4 characters."""
    return max(1, len(text) // 4)


# Maximum characters of raw code included in the `content` field that the
# Kibana agent reads.  At ~4 chars/token this is ≈ 500 tokens per file —
# enough for the agent to understand the file without blowing the context window
# when dozens of files are retrieved simultaneously.
CONTENT_SNIPPET_CHARS = 2000

def infer_language(file_path: str) -> str:
    """Derive a human-readable language label from the file extension."""
    ext = os.path.splitext(file_path)[1].lower()
    _LANG_MAP = {
        ".ts": "TypeScript",
        ".tsx": "TypeScript",
        ".jsx": "TypeScript",
        ".js": "JavaScript",
        ".py": "Python",
        ".json": "JSON",
        ".md": "Markdown",
    }
    return _LANG_MAP.get(ext, "code")


async def generate_file_summary(file_path: str, content: str) -> str:
    """
    Call claude-haiku-4-5-20251001 to generate a 2-3 sentence description of what
    the file does. Returns a fallback string on any error — never raises.
    """
    if not ANTHROPIC_API_KEY:
        return "Summary unavailable: ANTHROPIC_API_KEY not configured."
    language = infer_language(file_path)
    # Cap at 8 000 chars (~2k tokens) — ample context for haiku to summarise.
    snippet = content[:8000]
    prompt = (
        f"You are a code documentation assistant. "
        f"The following is the content of a {language} file named `{file_path}`.\n\n"
        f"```{language.lower()}\n{snippet}\n```\n\n"
        f"Write exactly 2-3 sentences in plain English that describe: "
        f"(1) what this file does or is responsible for, "
        f"(2) the key functions, classes, or exports it provides, and "
        f"(3) how it fits into the broader codebase if that is evident from the content. "
        f"No code. No bullet points. Output only the sentences."
    )
    try:
        client = anthropic_sdk.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        message = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        text = message.content[0].text.strip() if message.content else ""
        return text or f"No summary generated for {file_path}."
    except Exception as exc:  # never block indexing on summary failure
        return f"Summary generation failed for {file_path}: {type(exc).__name__}."


def get_user_token_doc(db, uid: str) -> Dict[str, Any]:
    """Return the users/{uid}/token_usage document, or {} if absent."""
    try:
        snap = db.collection("users").document(uid).collection("token_usage").document("totals").get()
        return snap.to_dict() or {} if snap.exists else {}
    except Exception:
        return {}


def get_user_tier(db, uid: str) -> str:
    """Return the user's subscription tier (defaults to 'free')."""
    try:
        snap = db.collection("users").document(uid).get()
        data = snap.to_dict() or {} if snap.exists else {}
        return str(data.get("subscription_tier", DEFAULT_TIER))
    except Exception:
        return DEFAULT_TIER


def check_token_quota(db, uid: str, tokens_to_add: int) -> None:
    """
    Raise HTTP 429 if the user would exceed their subscription limit.
    No-ops gracefully if Firestore is unavailable.
    """
    if db is None:
        return
    tier = get_user_tier(db, uid)
    limit = SUBSCRIPTION_LIMITS.get(tier, SUBSCRIPTION_LIMITS[DEFAULT_TIER])
    if limit is None:
        return  # unlimited tier

    usage = get_user_token_doc(db, uid)
    current = int(usage.get("tokens_embedded", 0))
    if current + tokens_to_add > limit:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Token limit reached. Your {tier!r} plan allows {limit:,} tokens. "
                f"Currently used: {current:,}. "
                f"Attempted to add: {tokens_to_add:,}. "
                "Upgrade your subscription to continue indexing."
            ),
        )


def increment_token_usage(db, uid: str, tokens: int, files_count: int) -> None:
    """Atomically increment token_usage totals in Firestore."""
    if db is None or tokens == 0:
        return
    try:
        from google.cloud.firestore_v1 import Increment
        ref = db.collection("users").document(uid).collection("token_usage").document("totals")
        ref.set(
            {
                "tokens_embedded": Increment(tokens),
                "files_embedded": Increment(files_count),
                "last_updated_at": datetime.now(timezone.utc).isoformat(),
            },
            merge=True,
        )
    except Exception:
        pass


def decrement_token_usage(db, uid: str, tokens: int, files_count: int) -> None:
    """Decrement token usage when docs are pruned (floor at 0 via max in app logic)."""
    if db is None or tokens == 0:
        return
    try:
        from google.cloud.firestore_v1 import Increment
        ref = db.collection("users").document(uid).collection("token_usage").document("totals")
        # Decrement — Firestore doesn't clamp at 0 natively; negative is acceptable as it self-corrects.
        ref.set(
            {
                "tokens_embedded": Increment(-tokens),
                "files_embedded": Increment(-files_count),
                "last_updated_at": datetime.now(timezone.utc).isoformat(),
            },
            merge=True,
        )
    except Exception:
        pass


def update_workspace_metadata(uid: str, workspace_id: str, patch: Dict[str, Any]) -> None:
    client = get_firestore_client()
    if client is None:
        return
    try:
        now = datetime.now(timezone.utc).isoformat()
        users_ref = client.collection("users").document(uid)
        users_ref.set({"last_seen_at": now}, merge=True)
        # Firestore doc IDs cannot contain '/' — replace with '_' for owner/repo slugs
        doc_id = workspace_id.replace("/", "_")
        ws_ref = users_ref.collection("workspaces").document(doc_id)
        ws_ref.set({"workspace_id": workspace_id, "updated_at": now, **patch}, merge=True)
    except Exception:
        return


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/ingest")
async def ingest(request: IngestRequest, auth_ctx: AuthContext = Depends(require_auth_context)):
    try:
        client = get_es_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    db = get_firestore_client()

    # ------------------------------------------------------------------
    # Hash-based deduplication: fetch existing hashes from ES, then
    # filter to only files that are new or changed. This ensures we never
    # call Anthropic for a file whose content hasn't changed.
    # ------------------------------------------------------------------
    # existing_docs maps file_path -> {content_hash, token_count} for already-indexed files
    existing_docs: Dict[str, Dict[str, Any]] = {}
    try:
        hash_query = {
            "bool": {
                "filter": [
                    {"term": {"user_id.keyword": auth_ctx.uid}},
                    {"term": {"workspace_id.keyword": request.workspace_id}},
                    {"term": {"doc_type.keyword": SOURCE_DOC_TYPE}},
                ]
            }
        }
        hash_response = client.search(
            index=INDEX_NAME,
            query=hash_query,
            source=["file_path", "content_hash", "token_count"],
            size=5000,
        )
        for hit in hash_response.get("hits", {}).get("hits", []):
            src = hit.get("_source", {})
            fp = src.get("file_path")
            if isinstance(fp, str):
                existing_docs[fp] = {
                    "content_hash": src.get("content_hash", ""),
                    "token_count": int(src.get("token_count") or 0),
                }
    except Exception:
        pass  # If fetch fails, treat all files as changed (safe fallback)

    def md5(text: str) -> str:
        return hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()

    changed_files = [
        f for f in request.files
        if md5(f.content) != existing_docs.get(f.file_path, {}).get("content_hash", "")
    ]

    if not changed_files:
        return {"indexed": 0, "skipped": len(request.files), "user_id": auth_ctx.uid, "tokens_embedded": 0}

    # Net token delta: new tokens minus the old tokens for files being replaced.
    # New files (not in existing_docs) contribute their full token count.
    # Updated files contribute only the difference — so the quota tracks actual stored tokens.
    net_tokens = sum(
        estimate_tokens(f.content) - existing_docs.get(f.file_path, {}).get("token_count", 0)
        for f in changed_files
    )

    # Quota check — raises 429 if the net addition would exceed the limit
    check_token_quota(db, auth_ctx.uid, max(0, net_tokens))

    # Generate semantic summaries concurrently — only for changed/new files.
    summaries = await asyncio.gather(
        *[generate_file_summary(f.file_path, f.content) for f in changed_files]
    )

    indexed = 0
    for file, semantic_summary in zip(changed_files, summaries):
        new_token_count = estimate_tokens(file.content)
        # `content` is what the Kibana agent retrieves into its context window.
        # We keep it compact: summary + a short code snippet so the agent can
        # understand the file without blowing the 200k-token context limit when
        # many files are returned simultaneously.
        snippet = file.content[:CONTENT_SNIPPET_CHARS]
        snippet_note = (
            f"\n\n[Snippet truncated to {CONTENT_SNIPPET_CHARS} chars. Full source in raw_code field.]"
            if len(file.content) > CONTENT_SNIPPET_CHARS else ""
        )
        compact_content = (
            f"[Project: {request.workspace_id} | File: {file.file_path}]\n"
            f"Summary: {semantic_summary}\n\n"
            f"```\n{snippet}{snippet_note}\n```"
        )
        doc = {
            "user_id": auth_ctx.uid,
            "workspace_id": request.workspace_id,
            "project_name": request.workspace_id,
            "doc_type": SOURCE_DOC_TYPE,
            "file_path": file.file_path,
            "language": infer_language(file.file_path),
            "semantic_summary": semantic_summary,
            "raw_code": file.content,
            "content": compact_content,  # compact — safe for Kibana context window
            "content_hash": md5(file.content),
            "token_count": new_token_count,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        doc_id = build_source_doc_id(auth_ctx.uid, request.workspace_id, file.file_path)
        client.index(index=INDEX_NAME, id=doc_id, document=doc)
        indexed += 1

    # Increment by net delta only (can be negative if files got smaller, which is fine)
    if net_tokens != 0:
        if net_tokens > 0:
            increment_token_usage(db, auth_ctx.uid, net_tokens, indexed)
        else:
            decrement_token_usage(db, auth_ctx.uid, abs(net_tokens), 0)

    meta_patch: Dict[str, Any] = {
        "last_ingest_at": datetime.now(timezone.utc).isoformat(),
        "last_ingest_count": indexed,
    }
    if request.git_remote:
        meta_patch["git_remote"] = request.git_remote
    if request.local_root_path:
        meta_patch["local_root_path"] = request.local_root_path
    update_workspace_metadata(auth_ctx.uid, request.workspace_id, meta_patch)
    skipped = len(request.files) - len(changed_files)
    return {"indexed": indexed, "skipped": skipped, "user_id": auth_ctx.uid, "net_tokens": net_tokens}


@app.post("/api/summarize-workspace")
async def summarize_workspace(request: SummarizeRequest, auth_ctx: AuthContext = Depends(require_auth_context)):
    try:
        client = get_es_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        files = fetch_workspace_source_docs(client, auth_ctx.uid, request.workspace_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch workspace docs: {exc}") from exc

    if not files:
        return {"summary_indexed": False, "source_files": 0, "message": "No source files found for this workspace."}

    summary = build_workspace_summary(request.workspace_id, files)
    summary_doc = {
        "user_id": auth_ctx.uid,
        "workspace_id": request.workspace_id,
        "doc_type": SUMMARY_DOC_TYPE,
        "file_path": SUMMARY_DOC_PATH,
        "content": summary,
        "source_file_count": len(files),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    summary_id = build_summary_doc_id(auth_ctx.uid, request.workspace_id)
    client.index(index=INDEX_NAME, id=summary_id, document=summary_doc)
    update_workspace_metadata(
        auth_ctx.uid,
        request.workspace_id,
        {"last_summary_at": datetime.now(timezone.utc).isoformat(), "summary_source_files": len(files)},
    )
    return {"summary_indexed": True, "source_files": len(files), "summary_chars": len(summary)}


@app.post("/api/prune-workspace-scope")
async def prune_workspace_scope(request: PruneRequest, auth_ctx: AuthContext = Depends(require_auth_context)):
    try:
        client = get_es_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    db = get_firestore_client()
    indexed_paths = set(request.indexed_file_paths)

    docs = fetch_workspace_source_docs_with_ids(client, auth_ctx.uid, request.workspace_id)
    delete_ids: List[str] = []
    pruned_tokens = 0
    for doc in docs:
        file_path = doc.get("file_path")
        if not isinstance(file_path, str) or not file_path:
            continue
        if file_path not in indexed_paths:
            doc_id = doc.get("_id")
            if isinstance(doc_id, str) and doc_id:
                delete_ids.append(doc_id)
                pruned_tokens += int(doc.get("token_count") or 0)

    for doc_id in delete_ids:
        client.delete(index=INDEX_NAME, id=doc_id, ignore=[404])

    # Decrement token usage for pruned docs
    if delete_ids:
        decrement_token_usage(db, auth_ctx.uid, pruned_tokens, len(delete_ids))

    update_workspace_metadata(
        auth_ctx.uid,
        request.workspace_id,
        {"last_prune_at": datetime.now(timezone.utc).isoformat(), "last_prune_deleted": len(delete_ids)},
    )
    return {"deleted": len(delete_ids), "scanned": len(docs), "tokens_freed": pruned_tokens}


@app.get("/api/usage")
async def get_usage(auth_ctx: AuthContext = Depends(require_auth_context)):
    """Return the current user's token usage and subscription quota."""
    db = get_firestore_client()
    if db is None:
        return {
            "tokens_embedded": 0,
            "files_embedded": 0,
            "tier": DEFAULT_TIER,
            "limit": SUBSCRIPTION_LIMITS[DEFAULT_TIER],
            "limit_reached": False,
        }

    tier = get_user_tier(db, auth_ctx.uid)
    usage = get_user_token_doc(db, auth_ctx.uid)
    tokens_embedded = int(usage.get("tokens_embedded", 0))
    files_embedded = int(usage.get("files_embedded", 0))
    last_updated_at = usage.get("last_updated_at")
    limit = SUBSCRIPTION_LIMITS.get(tier, SUBSCRIPTION_LIMITS[DEFAULT_TIER])

    return {
        "tokens_embedded": tokens_embedded,
        "files_embedded": files_embedded,
        "tier": tier,
        "limit": limit,
        "limit_reached": False if limit is None else tokens_embedded >= limit,
        "last_updated_at": last_updated_at,
    }


@app.get("/api/projects")
async def list_projects(auth_ctx: AuthContext = Depends(require_auth_context)):
    """Return the distinct workspace/project names the user has indexed, with metadata."""
    try:
        es = get_es_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    query = {
        "bool": {
            "filter": [
                {"term": {"user_id.keyword": auth_ctx.uid}},
                {"term": {"doc_type.keyword": SOURCE_DOC_TYPE}},
            ]
        }
    }
    agg = {"projects": {"terms": {"field": "workspace_id.keyword", "size": 200}}}
    try:
        response = es.search(index=INDEX_NAME, query=query, aggregations=agg, size=0)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Elasticsearch error: {exc}") from exc

    buckets = response.get("aggregations", {}).get("projects", {}).get("buckets", [])
    workspace_ids = sorted(b["key"] for b in buckets if isinstance(b.get("key"), str))

    # Enrich with Firestore metadata (git_remote, local_root_path, last_ingest_at)
    db = get_firestore_client()
    projects: List[Dict[str, Any]] = []
    for ws_id in workspace_ids:
        entry: Dict[str, Any] = {"workspace_id": ws_id}
        if db:
            try:
                snap = db.collection("users").document(auth_ctx.uid).collection("workspaces").document(ws_id.replace("/", "_")).get()
                if snap.exists:
                    data = snap.to_dict() or {}
                    for key in ("git_remote", "local_root_path", "last_ingest_at"):
                        if data.get(key):
                            entry[key] = data[key]
            except Exception:
                pass
        projects.append(entry)

    return {"projects": projects}


@app.get("/api/workspace-hashes")
async def workspace_hashes(workspace_id: str, auth_ctx: AuthContext = Depends(require_auth_context)):
    """Return a map of {file_path: content_hash} for every source file in the workspace.

    The extension fetches this before a full re-index to skip files whose content
    hasn't changed, avoiding unnecessary Anthropic summary calls.
    """
    try:
        es = get_es_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    query = {
        "bool": {
            "filter": [
                {"term": {"user_id.keyword": auth_ctx.uid}},
                {"term": {"workspace_id.keyword": workspace_id}},
                {"term": {"doc_type.keyword": SOURCE_DOC_TYPE}},
            ]
        }
    }
    try:
        response = es.search(
            index=INDEX_NAME,
            query=query,
            source=["file_path", "content_hash"],
            size=5000,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Elasticsearch error: {exc}") from exc

    hashes: Dict[str, str] = {}
    for hit in response.get("hits", {}).get("hits", []):
        src = hit.get("_source", {})
        fp = src.get("file_path")
        ch = src.get("content_hash")
        if isinstance(fp, str) and isinstance(ch, str):
            hashes[fp] = ch

    return {"hashes": hashes}


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest, auth_ctx: AuthContext = Depends(require_auth_context)):
    """SSE streaming wrapper around the Kibana agent.

    Emits Server-Sent Events so the extension/UI can show live progress:
      - data: {"type":"status","message":"..."} — thinking indicator steps
      - data: {"type":"steps","steps":[...]}    — agent trace steps (when available)
      - data: {"type":"reply","text":"..."}     — final answer
      - data: {"type":"error","message":"..."}  — error
      - data: {"type":"done"}                   — stream complete
    """
    if not KIBANA_URL or not ELASTIC_API_KEY or not AGENT_ID:
        async def _err():
            yield 'data: {"type":"error","message":"Missing KIBANA_URL, ELASTIC_API_KEY, or AGENT_ID"}\n\n'
            yield 'data: {"type":"done"}\n\n'
        return StreamingResponse(_err(), media_type="text/event-stream")

    base_url = normalize_kibana_base_url(KIBANA_URL)
    url = f"{base_url}/api/agent_builder/converse"
    headers = {
        "Authorization": f"ApiKey {ELASTIC_API_KEY}",
        "kbn-xsrf": "true",
        "Content-Type": "application/json",
    }
    scoped_input = (
        f"[SCOPE] user_id: {auth_ctx.uid} | workspace_id: {request.workspace_id}\n\n"
        f"user_question: {request.message}"
    )
    payload = {"input": scoped_input, "agent_id": AGENT_ID}

    import json as _json

    # Status messages shown while waiting for Kibana (cycles every 4 s)
    THINKING_STEPS = [
        "Thinking...",
        "Searching your codebase...",
        "Analyzing results...",
        "Synthesizing answer...",
    ]

    async def event_stream():
        # Fire status ticks while the Kibana request runs concurrently
        tick_index = 0

        # Start the Kibana request as a background task
        kibana_task = asyncio.create_task(_call_kibana(url, headers, payload))

        try:
            while not kibana_task.done():
                msg = THINKING_STEPS[tick_index % len(THINKING_STEPS)]
                tick_index += 1
                yield f"data: {_json.dumps({'type': 'status', 'message': msg})}\n\n"
                # wait 2 s or until task finishes
                try:
                    await asyncio.wait_for(asyncio.shield(kibana_task), timeout=2.0)
                except asyncio.TimeoutError:
                    pass  # keep going

            data, error = kibana_task.result()
        except Exception as exc:
            yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            yield 'data: {"type":"done"}\n\n'
            return

        if error:
            yield f"data: {_json.dumps({'type': 'error', 'message': error})}\n\n"
            yield 'data: {"type":"done"}\n\n'
            return

        if data is None:
            yield f"data: {_json.dumps({'type': 'error', 'message': 'Kibana returned an empty response (no JSON body).'})}\n\n"
            yield 'data: {"type":"done"}\n\n'
            return

        steps = extract_steps(data)
        if steps:
            yield f"data: {_json.dumps({'type': 'steps', 'steps': steps})}\n\n"

        reply = _extract_reply_raw(data)
        if not reply:
            # Log the raw response shape to aid debugging, then surface as error
            raw_keys = list(data.keys()) if isinstance(data, dict) else type(data).__name__
            yield f"data: {_json.dumps({'type': 'error', 'message': f'Agent returned no reply. Response keys: {raw_keys}'})}\n\n"
            yield 'data: {"type":"done"}\n\n'
            return

        # Stream the reply word-by-word for a typewriter feel
        words = reply.split(" ")
        chunk_size = 3
        for i in range(0, len(words), chunk_size):
            chunk = " ".join(words[i:i + chunk_size])
            if i + chunk_size < len(words):
                chunk += " "
            yield f"data: {_json.dumps({'type': 'chunk', 'text': chunk})}\n\n"
            await asyncio.sleep(0.02)

        yield f"data: {_json.dumps({'type': 'reply', 'text': reply})}\n\n"
        yield 'data: {"type":"done"}\n\n'

        update_workspace_metadata(
            auth_ctx.uid,
            request.workspace_id,
            {"last_chat_at": datetime.now(timezone.utc).isoformat()},
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _call_kibana(url: str, headers: dict, payload: dict):
    """Run the Kibana request and return (data, error_str). Never raises."""
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
        return data, None
    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:1000] if exc.response is not None else ""
        return None, f"Kibana HTTP {exc.response.status_code if exc.response else 'unknown'}: {body}"
    except Exception as exc:
        return None, str(exc)


@app.post("/api/chat")
async def chat(request: ChatRequest, auth_ctx: AuthContext = Depends(require_auth_context)):
    if not KIBANA_URL or not ELASTIC_API_KEY or not AGENT_ID:
        raise HTTPException(status_code=500, detail="Missing KIBANA_URL, ELASTIC_API_KEY, or AGENT_ID")

    base_url = normalize_kibana_base_url(KIBANA_URL)
    url = f"{base_url}/api/agent_builder/converse"
    headers = {
        "Authorization": f"ApiKey {ELASTIC_API_KEY}",
        "kbn-xsrf": "true",
        "Content-Type": "application/json",
    }
    es = get_es_client()
    source_docs = fetch_workspace_source_docs(es, auth_ctx.uid, request.workspace_id)

    context_block = "\n\n".join(d["content"] for d in source_docs)
    scoped_input = (
        f"The following documents are the ONLY source of truth for this question. "
        f"Do not use any other knowledge or documents.\n\n"
        f"{context_block}\n\n"
        f"user_question: {request.message}"
    )
    payload = {"input": scoped_input, "agent_id": AGENT_ID}

    async with httpx.AsyncClient(timeout=90) as client:
        try:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:1000] if exc.response is not None else ""
            detail = (
                f"Kibana returned HTTP {exc.response.status_code if exc.response else 'unknown'} "
                f"for {url}. Body: {body}"
            )
            raise HTTPException(status_code=502, detail=detail) from exc
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"Kibana request failed for {url}: {exc}") from exc

    data = response.json()
    update_workspace_metadata(
        auth_ctx.uid,
        request.workspace_id,
        {"last_chat_at": datetime.now(timezone.utc).isoformat()},
    )
    return {
        "reply": extract_reply(data),
        "steps": extract_steps(data),
        "conversation_id": data.get("conversation_id"),
        "round_id": data.get("round_id"),
        "user_id": auth_ctx.uid,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_reply_raw(data: dict) -> Optional[str]:
    """Return the agent reply text, or None if nothing found."""
    if isinstance(data, dict):
        response = data.get("response")
        if isinstance(response, dict):
            message = response.get("message")
            if isinstance(message, str) and message.strip():
                return message
        messages = data.get("messages")
        if isinstance(messages, list):
            for msg in reversed(messages):
                if isinstance(msg, dict) and msg.get("role") == "assistant":
                    content = msg.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
        for key in ("output", "message", "reply", "text"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return None


def extract_reply(data: dict) -> str:
    return _extract_reply_raw(data) or "No reply received."


def extract_steps(data: dict) -> List[dict[str, Any]]:
    raw_steps = data.get("steps") if isinstance(data, dict) else None
    return [step for step in raw_steps if isinstance(step, dict)] if isinstance(raw_steps, list) else []


def normalize_kibana_base_url(url: str) -> str:
    normalized = url.rstrip("/")
    return normalized[:-4] if normalized.endswith("/api") else normalized


def build_source_doc_id(user_id: str, workspace_id: str, file_path: str) -> str:
    return f"{user_id}:{workspace_id}:source:{file_path}"


def build_summary_doc_id(user_id: str, workspace_id: str) -> str:
    return f"{user_id}:{workspace_id}:summary"



def fetch_workspace_source_docs(client: Elasticsearch, user_id: str, workspace_id: str) -> List[dict[str, str]]:
    docs = fetch_workspace_source_docs_with_ids(client, user_id, workspace_id)
    files: List[dict[str, str]] = []
    for doc in docs:
        file_path = doc.get("file_path")
        content = doc.get("content")
        if isinstance(file_path, str) and isinstance(content, str):
            files.append({"file_path": file_path, "content": content})
    return files


def fetch_workspace_source_docs_with_ids(client: Elasticsearch, user_id: str, workspace_id: str) -> List[dict[str, Any]]:
    query = {
        "bool": {
            "filter": [
                {"term": {"user_id.keyword": user_id}},
                {"term": {"workspace_id.keyword": workspace_id}},
            ],
            "should": [
                {"term": {"doc_type.keyword": SOURCE_DOC_TYPE}},
                {"bool": {"must_not": {"exists": {"field": "doc_type"}}}},
            ],
            "minimum_should_match": 1,
        }
    }
    response = client.search(index=INDEX_NAME, query=query, source=["file_path", "content", "token_count"], size=5000)
    hits = response.get("hits", {}).get("hits", [])
    return [
        {
            "_id": hit.get("_id"),
            "file_path": hit.get("_source", {}).get("file_path"),
            "content": hit.get("_source", {}).get("content"),
            "token_count": hit.get("_source", {}).get("token_count"),
        }
        for hit in hits
    ]


def build_workspace_summary(workspace_id: str, files: List[dict[str, str]]) -> str:
    generated_at = datetime.now(timezone.utc).isoformat()
    lines: List[str] = [
        f"# Workspace Summary: {workspace_id}",
        "",
        f"Generated at: {generated_at}",
        f"Source files indexed: {len(files)}",
        "",
        "## Project Overview",
        "This summary describes the codebase structure, key modules, core functions, and interactions.",
        "",
        "## Module Map",
    ]
    files_sorted = sorted(files, key=lambda x: x["file_path"].lower())
    for file in files_sorted:
        file_path = file["file_path"]
        content = file["content"]
        purpose = infer_file_purpose(content)
        imports = extract_imports(file_path, content)
        classes = extract_classes(file_path, content)
        functions = extract_functions(file_path, content)
        lines.append(f"### {file_path}")
        lines.append(f"- Purpose: {purpose}")
        if imports:
            lines.append(f"- Depends on: {', '.join(imports[:20])}")
        if classes:
            lines.append(f"- Classes: {', '.join(classes[:25])}")
        if functions:
            lines.append(f"- Functions: {', '.join(functions[:60])}")
        if not imports and not classes and not functions:
            lines.append("- Symbols: No explicit functions/classes parsed.")
        lines.append("")
    lines.append("## Function Catalog")
    for file in files_sorted:
        file_path = file["file_path"]
        catalog_entries = extract_function_entries(file_path, file["content"])
        if not catalog_entries:
            continue
        lines.append(f"### {file_path}")
        for entry in catalog_entries[:120]:
            lines.append(f"- {entry}")
        lines.append("")
    lines.append("## Interaction Notes")
    lines.append("- Use module imports above to trace dependencies across files.")
    lines.append("- For exact logic, refer to source file documents; this summary is structural.")
    summary = "\n".join(lines).strip()
    return summary[:180000] + ("\n\n[Summary truncated due to size limits.]" if len(summary) > 180000 else "")


def infer_file_purpose(content: str) -> str:
    for line in content.splitlines()[:20]:
        trimmed = line.strip()
        if trimmed.startswith("#"):
            return trimmed.lstrip("#").strip() or "Comment-defined file purpose."
        if trimmed.startswith("//"):
            return trimmed.lstrip("/").strip() or "Comment-defined file purpose."
        if trimmed.startswith('"""') or trimmed.startswith("'''"):
            doc = trimmed.strip('"').strip("'").strip()
            if doc:
                return doc
    return "Module logic and definitions for this part of the workspace."


def extract_imports(file_path: str, content: str) -> List[str]:
    imports: List[str] = []
    if file_path.endswith((".ts", ".js", ".tsx", ".jsx")):
        imports.extend(re.findall(r"^\s*import\s+.*?\s+from\s+['\"]([^'\"]+)['\"]", content, flags=re.MULTILINE))
        imports.extend(re.findall(r"^\s*const\s+.*?=\s*require\(['\"]([^'\"]+)['\"]\)", content, flags=re.MULTILINE))
    elif file_path.endswith(".py"):
        imports.extend(re.findall(r"^\s*import\s+([a-zA-Z0-9_\.]+)", content, flags=re.MULTILINE))
        imports.extend(re.findall(r"^\s*from\s+([a-zA-Z0-9_\.]+)\s+import", content, flags=re.MULTILINE))
    return dedupe_keep_order(imports)


def extract_classes(file_path: str, content: str) -> List[str]:
    if file_path.endswith((".ts", ".js", ".tsx", ".jsx", ".py")):
        return dedupe_keep_order(re.findall(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)", content, flags=re.MULTILINE))
    return []


def extract_functions(file_path: str, content: str) -> List[str]:
    names: List[str] = []
    if file_path.endswith((".ts", ".js", ".tsx", ".jsx")):
        names.extend(re.findall(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", content, flags=re.MULTILINE))
        names.extend(re.findall(r"^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>", content, flags=re.MULTILINE))
    elif file_path.endswith(".py"):
        names.extend(re.findall(r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", content, flags=re.MULTILINE))
    return dedupe_keep_order(names)


def extract_function_entries(file_path: str, content: str) -> List[str]:
    entries: List[str] = []
    if file_path.endswith((".ts", ".js", ".tsx", ".jsx")):
        for name, args in re.findall(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)", content, flags=re.MULTILINE):
            entries.append(f"{name}({sanitize_args(args)}) - Defined in {file_path}.")
        for name, args in re.findall(r"^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>", content, flags=re.MULTILINE):
            entries.append(f"{name}({sanitize_args(args)}) - Defined in {file_path}.")
    elif file_path.endswith(".py"):
        for name, args in re.findall(r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)", content, flags=re.MULTILINE):
            entries.append(f"{name}({sanitize_args(args)}) - Defined in {file_path}.")
    return entries


def sanitize_args(args: str) -> str:
    compact = " ".join(args.split())
    return compact[:117] + "..." if len(compact) > 120 else compact


def dedupe_keep_order(items: List[str]) -> List[str]:
    seen: set[str] = set()
    output: List[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            output.append(item)
    return output
