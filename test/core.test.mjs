// The device-grant client, against a stubbed wire. Every network call
// rides the injected `http`; credentials land in a temp XDG_CONFIG_HOME.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beginDeviceLogin,
  clearCredentials,
  credentialsPath,
  decodeJwtPayload,
  ask,
  ensureFresh,
  expired,
  loadCredentials,
  login,
  pollDeviceToken,
  refreshTokens,
  saveCredentials,
} from "../lib/core.mjs";

const HOME = mkdtempSync(join(tmpdir(), "ommisa-test-"));
const ENV = { XDG_CONFIG_HOME: HOME };

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64(payload)}.sig`;
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noSleep = () => Promise.resolve();

test("credentials roundtrip: save is 0600, load reads, clear removes", () => {
  const p = saveCredentials({ access_token: "t" }, ENV);
  assert.equal(p, join(HOME, "ommisa", "credentials.json"));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(loadCredentials(ENV), { access_token: "t" });
  clearCredentials(ENV);
  assert.equal(existsSync(p), false);
});

test("beginDeviceLogin returns the ceremony; a refusal carries the OP's words", async () => {
  const begin = await beginDeviceLogin(async (url, init) => {
    assert.equal(url, "https://id.oimlsmart.org/op/device/authorization");
    assert.ok(String(init.body).includes("client_id=oiml-ommisa"));
    assert.ok(String(init.body).includes("oiml-ai%3Aread"));
    return jsonRes(200, { device_code: "dc1", user_code: "ABCD-EFGH", verification_uri: "https://id.oimlsmart.org/op/device", expires_in: 600, interval: 5 });
  }, { issuer: "https://id.oimlsmart.org", clientId: "oiml-ommisa", scope: "oiml-ai:read" });
  assert.equal(begin.user_code, "ABCD-EFGH");

  await assert.rejects(
    beginDeviceLogin(async () => jsonRes(401, { error: "invalid_client", error_description: "unknown or disabled client" }), {
      issuer: "https://id.oimlsmart.org",
      clientId: "invented",
      scope: "oiml-ai:read",
    }),
    /unknown or disabled client/,
  );
});

test("the poll honors authorization_pending, slow_down (+5s), and success", async () => {
  const answers = [
    jsonRes(400, { error: "authorization_pending" }),
    jsonRes(400, { error: "slow_down" }),
    jsonRes(400, { error: "authorization_pending" }),
    jsonRes(200, { access_token: "at1", refresh_token: "rt1", id_token: jwt({ sub: "acct-9", name: "Ronald" }), expires_in: 600, token_type: "Bearer", scope: "oiml-ai:read offline_access" }),
  ];
  const paces = [];
  const tokens = await pollDeviceToken(
    async () => answers.shift(),
    { issuer: "https://id.example.org", clientId: "oiml-ommisa", deviceCode: "dc1", interval: 5, sleepFn: (ms) => (paces.push(ms), Promise.resolve()) },
  );
  assert.equal(tokens.access_token, "at1");
  assert.deepEqual(paces, [5000, 5000, 10000, 10000]);
});

test("an access_denied or expired_token poll fails with the OP's words", async () => {
  await assert.rejects(
    pollDeviceToken(async () => jsonRes(400, { error: "access_denied", error_description: "the account holder declined" }), {
      issuer: "https://id.example.org",
      clientId: "oiml-ommisa",
      deviceCode: "dc1",
      interval: 1,
      sleepFn: noSleep,
    }),
    /the account holder declined/,
  );
});

test("login orchestrates the ceremony and persists 0600 credentials with decoded claims", async () => {
  const lines = [];
  let polls = 0;
  const http = async (url) => {
    if (url.endsWith("/op/device/authorization")) {
      return jsonRes(200, { device_code: "dc1", user_code: "ABCD-EFGH", verification_uri: "https://id.example.org/op/device", expires_in: 600, interval: 5 });
    }
    polls++;
    return polls === 1
      ? jsonRes(400, { error: "authorization_pending" })
      : jsonRes(200, { access_token: "at1", refresh_token: "rt1", id_token: jwt({ sub: "acct-9", name: "Ronald", roles: ["member"] }), expires_in: 600, token_type: "Bearer", scope: "oiml-ai:read offline_access" });
  };
  const { creds, path, claims } = await login({}, { env: ENV, http, stdout: (l) => lines.push(l), open: async () => false, sleepFn: noSleep });
  assert.equal(claims.name, "Ronald");
  assert.equal(creds.refresh_token, "rt1");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(lines.some((l) => l.includes("ABCD-EFGH")));
  assert.equal(expired(creds), false);
  rmSync(path);
});

test("an expired access token refreshes, and the ROTATION persists", async () => {
  const creds = { access_token: "stale", refresh_token: "rt-old", expires_at: Date.now() - 1000, issuer: "https://id.example.org", client_id: "oiml-ommisa", api: "https://ai.example.org" };
  assert.equal(expired(creds), true);
  let asked = 0;
  const next = await refreshTokens(async (url, init) => {
    asked++;
    assert.equal(url, "https://id.example.org/op/token");
    const body = String(init.body);
    assert.ok(body.includes("grant_type=refresh_token"));
    assert.ok(body.includes("refresh_token=rt-old"));
    return jsonRes(200, { access_token: "fresh", refresh_token: "rt-new", expires_in: 600 });
  }, { issuer: "https://id.example.org", clientId: "oiml-ommisa" }, creds, ENV);
  assert.equal(asked, 1);
  assert.equal(next.access_token, "fresh");
  assert.equal(next.refresh_token, "rt-new");
  const stored = loadCredentials(ENV);
  assert.equal(stored.refresh_token, "rt-new");
  assert.equal(expired(next), false);
  clearCredentials(ENV);
});

test("a refresh without a rotated token keeps the old pair", async () => {
  const creds = { access_token: "stale", refresh_token: "rt-old", expires_at: Date.now() - 1000, issuer: "https://id.example.org", client_id: "oiml-ommisa" };
  const next = await refreshTokens(async () => jsonRes(200, { access_token: "fresh", expires_in: 600 }), { issuer: "https://id.example.org", clientId: "oiml-ommisa" }, creds, ENV);
  assert.equal(next.refresh_token, "rt-old");
  clearCredentials(ENV);
});

test("ensureFresh passes a live token through untouched", async () => {
  let calls = 0;
  const creds = { access_token: "live", expires_at: Date.now() + 600_000 };
  const out = await ensureFresh(async () => (calls++, jsonRes(200, {})), creds, ENV);
  assert.equal(calls, 0);
  assert.equal(out, creds);
});

test("ask sends the Bearer and stream:false; failures carry the service's words", async () => {
  const answer = await ask(async (url, init) => {
    assert.equal(url, "https://ai.example.org/api/ask");
    assert.equal(init.headers.authorization, "Bearer at1");
    assert.deepEqual(JSON.parse(init.body), { query: "What is the MPE for a load cell?", stream: false });
    return jsonRes(200, { answer: "Per OIML R 60...", citations: [{ label: "OIML R 60-1 (2021) 4.4" }] });
  }, { api: "https://ai.example.org", query: "What is the MPE for a load cell?", accessToken: "at1" });
  assert.match(answer.answer, /R 60/);

  const e = await ask(async () => jsonRes(429, { error: "quota_exceeded", detail: "Daily question limit reached (300)." }), {
    api: "https://ai.example.org",
    query: "q",
    accessToken: "at1",
  }).catch((err) => err);
  assert.equal(e.status, 429);
  assert.match(e.message, /Daily question limit/);
});

test("decodeJwtPayload decodes base64url and refuses non-JWTs", () => {
  assert.deepEqual(decodeJwtPayload(jwt({ sub: "s1" })), { sub: "s1" });
  assert.equal(decodeJwtPayload("opaque-token"), null);
  assert.equal(decodeJwtPayload(null), null);
});
