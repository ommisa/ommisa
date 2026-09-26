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

export async function askApi(http, { api, query, accessToken, lang, fresh, history }) {
  const body = { query, stream: false };
  if (lang) body.lang = lang;
  if (fresh) body.fresh = true;
  if (history?.length) body.history = history;
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
