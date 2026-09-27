// The estate AI service's member-data API, as one honest client. Every
// call rides an injected `http` (the tests stub the wire) and carries
// the Bearer when the caller has one — the anon tier admits the same
// routes with no header. Errors surface the service's own words.

async function call(http, method, url, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await http(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.message || data?.error_description || data?.detail || data?.error || `the request failed (HTTP ${res.status})`);
    e.status = res.status;
    e.code = data?.error?.code || data?.error;
    throw e;
  }
  return data;
}

export async function health(http, api) {
  const res = await http(`${api}/health`);
  return res.json().catch(() => ({}));
}

export async function askApi(http, { api, query, accessToken, lang, fresh, history, image }) {
  const body = { query, stream: false };
  if (lang) body.lang = lang;
  if (fresh) body.fresh = true;
  if (history?.length) body.history = history;
  if (image) body.image = image;
  return call(http, "POST", `${api}/api/ask`, accessToken, body);
}

// ── memory files ─────────────────────────────────────────────────────

export function listMemories(http, api, token) {
  return call(http, "GET", `${api}/api/memories`, token);
}

export function createMemory(http, api, token, name, content) {
  return call(http, "POST", `${api}/api/memories`, token, { name, content });
}

export function deleteMemory(http, api, token, id) {
  return call(http, "DELETE", `${api}/api/memories/${encodeURIComponent(id)}`, token);
}

// ── conversations ────────────────────────────────────────────────────

export function listConversations(http, api, token) {
  return call(http, "GET", `${api}/api/conversations`, token);
}

export function getConversation(http, api, token, id) {
  return call(http, "GET", `${api}/api/conversations/${encodeURIComponent(id)}`, token);
}

export function createConversation(http, api, token, title) {
  return call(http, "POST", `${api}/api/conversations`, token, { title });
}

export function appendMessage(http, api, token, id, role, content, citations) {
  const body = citations ? { role, content, citations } : { role, content };
  return call(http, "POST", `${api}/api/conversations/${encodeURIComponent(id)}/messages`, token, body);
}

export function deleteConversation(http, api, token, id) {
  return call(http, "DELETE", `${api}/api/conversations/${encodeURIComponent(id)}`, token);
}

// ── projects and their files ─────────────────────────────────────────

export function listProjects(http, api, token) {
  return call(http, "GET", `${api}/api/projects`, token);
}

export function listProjectFiles(http, api, token, projectId) {
  return call(http, "GET", `${api}/api/projects/${encodeURIComponent(projectId)}/files`, token);
}

// ── the streaming ask: real stage events drive the spinner ───────────
/** POST /api/ask with stream:true; parses the SSE wire. Callbacks:
 *  onStage(label) — the spinner's line changes as the service reports;
 *  onToken(v) — answer text, as it arrives. Resolves the final JSON
 *  shape {answer, citations, quota, source_quality, ...}. */
export async function askStream(http, { api, query, accessToken, lang, fresh, history, image, onStage, onToken, signal }) {
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const body = { query, stream: true };
  if (lang) body.lang = lang;
  if (fresh) body.fresh = true;
  if (history?.length) body.history = history;
  if (image) body.image = image;
  const res = await http(`${api}/api/ask`, { method: "POST", headers, body: JSON.stringify(body), signal });
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || ct.includes("application/json")) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data?.error?.message || data?.detail || data?.error || `the ask failed (HTTP ${res.status})`);
      e.status = res.status;
      e.code = data?.error?.code || data?.error;
      throw e;
    }
    // a JSON answer on an SSE ask: emit it as one token
    onToken?.(data.answer ?? "");
    return { ...data, streamed: false };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = { answer: "", citations: [] };
  let stage = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.type === "read") onStage?.("Read as — " + (evt.read?.doc || evt.read?.term || "your question"));
      else if (evt.type === "citations") {
        out.citations = evt.citations ?? [];
        out.source_quality = evt.source_quality ?? null;
        out.confidence_note = evt.confidence_note ?? null;
        out.experimental_sources = evt.experimental_sources ?? [];
        out.quota = evt.quota ?? null;
        if (out.citations.length) onStage?.(`Found ${out.citations.length} source${out.citations.length === 1 ? "" : "s"}…`);
        else onStage?.("Reading the corpus…");
      } else if (evt.type === "token") {
        if (stage++ === 0) onStage?.(null); // the first word clears the spinner
        out.answer += evt.v ?? "";
        onToken?.(evt.v ?? "");
      } else if (evt.type === "done") {
        out.query_hash = evt.query_hash ?? null;
        out.model = evt.model ?? null;
        out.follow_ups = evt.follow_ups ?? [];
        out.blocks = evt.blocks ?? [];
      } else if (evt.type === "error") {
        const e = new Error(evt.message || "stream error");
        e.code = "stream_error";
        throw e;
      }
    }
  }
  return { ...out, streamed: true };
}
