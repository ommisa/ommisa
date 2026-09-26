// The member-data API client, against a stubbed wire.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  health,
  askApi,
  listMemories,
  createMemory,
  deleteMemory,
  listConversations,
  getConversation,
  createConversation,
  appendMessage,
  deleteConversation,
  listProjects,
  listProjectFiles,
} from "../lib/api.mjs";

function stub(routes) {
  const calls = [];
  const http = async (url, init = {}) => {
    calls.push({ url, init });
    const hit = routes.find((r) => r.match.test(url) && (!r.method || r.method === init.method));
    if (!hit) throw new Error(`no stub for ${init.method || "GET"} ${url}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  };
  return { calls, http };
}

test("the ask carries the bearer, stream:false, and the optionals", async () => {
  const s = stub([{ match: /\/api\/ask$/, body: { answer: "a", quota: { used: 1, limit: 300 } } }]);
  const r = await askApi(s.http, { api: "https://ai.example.org", query: "q", accessToken: "t", lang: "fr", fresh: true, history: [{ role: "user", content: "earlier" }] });
  assert.equal(r.answer, "a");
  const body = JSON.parse(s.calls[0].init.body);
  assert.deepEqual(body, { query: "q", stream: false, lang: "fr", fresh: true, history: [{ role: "user", content: "earlier" }] });
  assert.equal(s.calls[0].init.headers.authorization, "Bearer t");
});

test("the anon ask carries no header", async () => {
  const s = stub([{ match: /\/api\/ask$/, body: { answer: "a" } }]);
  await askApi(s.http, { api: "https://ai.example.org", query: "q" });
  assert.equal(s.calls[0].init.headers.authorization, undefined);
});

test("errors speak the service's words with their status", async () => {
  const s = stub([{ match: /\/api\/ask$/, status: 429, body: { error: { code: "quota_exceeded", message: "Daily question limit reached (300)." } } }]);
  const e = await askApi(s.http, { api: "https://ai.example.org", query: "q", accessToken: "t" }).catch((e) => e);
  assert.equal(e.status, 429);
  assert.match(e.message, /Daily question limit/);
});

test("memories: list, add, rm hit their verbs", async () => {
  const s = stub([
    { match: /\/api\/memories$/, method: "GET", body: { memories: [{ id: "m1", name: "n", content: "c", enabled: 1 }] } },
    { match: /\/api\/memories$/, method: "POST", body: { ok: true, id: "m2" } },
    { match: /\/api\/memories\/m1$/, method: "DELETE", body: { ok: true } },
  ]);
  const token = "t";
  assert.equal((await listMemories(s.http, "https://ai.example.org", token)).memories[0].id, "m1");
  assert.equal((await createMemory(s.http, "https://ai.example.org", token, "n", "c")).id, "m2");
  assert.equal(s.calls[1].init.method, "POST");
  await deleteMemory(s.http, "https://ai.example.org", token, "m1");
  assert.equal(s.calls[2].init.method, "DELETE");
});

test("conversations: list, show, new, append, rm", async () => {
  const s = stub([
    { match: /\/api\/conversations$/, method: "GET", body: { conversations: [{ id: "c1", title: "T", messages: 2 }] } },
    { match: /\/api\/conversations$/, method: "POST", status: 201, body: { id: "c2" } },
    { match: /\/api\/conversations\/c1$/, method: "GET", body: { conversation: { id: "c1", title: "T" }, messages: [{ role: "user", content: "hi", citations: null }] } },
    { match: /\/api\/conversations\/c1\/messages$/, method: "POST", body: { ok: true } },
    { match: /\/api\/conversations\/c1$/, method: "DELETE", body: { ok: true } },
  ]);
  const token = "t";
  const api = "https://ai.example.org";
  assert.equal((await listConversations(s.http, api, token)).conversations[0].id, "c1");
  assert.equal((await createConversation(s.http, api, token, "T")).id, "c2");
  const conv = await getConversation(s.http, api, token, "c1");
  assert.equal(conv.conversation.title, "T");
  await appendMessage(s.http, api, token, "c1", "user", "hi");
  const appendBody = JSON.parse(s.calls[3].init.body);
  assert.deepEqual(appendBody, { role: "user", content: "hi" });
  await deleteConversation(s.http, api, token, "c1");
});

test("projects: list and their files", async () => {
  const s = stub([
    { match: /\/api\/projects$/, method: "GET", body: { projects: [{ id: "p1", name: "P", file_count: 1, conversation_count: 0 }] } },
    { match: /\/api\/projects\/p1\/files$/, method: "GET", body: { files: [{ id: "f1", name: "F", content: "c" }] } },
  ]);
  assert.equal((await listProjects(s.http, "https://ai.example.org", "t")).projects[0].id, "p1");
  assert.equal((await listProjectFiles(s.http, "https://ai.example.org", "t", "p1")).files[0].id, "f1");
});

test("health rides bare (no auth)", async () => {
  const s = stub([{ match: /\/health$/, body: { ok: true, index_version: "v2.317" } }]);
  const h = await health(s.http, "https://ai.example.org");
  assert.equal(h.index_version, "v2.317");
  assert.equal(s.calls[0].init.headers?.authorization, undefined);
});
