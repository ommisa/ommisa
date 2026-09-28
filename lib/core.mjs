// The Ommisa credential store and the RFC 8628 device-grant client.
// Zero dependencies; every network call rides an injected `http` so the
// tests stub the wire. Credentials live under XDG_CONFIG_HOME (default
// ~/.config)/ommisa/credentials.json, written 0600.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULTS = Object.freeze({
  issuer: "https://id.oimlsmart.org",
  api: "https://ommisa.org",
  clientId: "oiml-ommisa",
  // the OP's device endpoint enforces the PAT grammar exactly —
  // '<service>:<read|write|admin>', space-joined; offline_access and the
  // OIDC scope names live on the authorization-code flow, not here
  scope: "oiml-ai:read oiml-ai:write",
  readOnlyScope: "oiml-ai:read",
});

export function resolveConfig(opts = {}, env = process.env) {
  return {
    issuer: (opts.issuer || env.OMMISA_ID || DEFAULTS.issuer).replace(/\/+$/, ""),
    api: (opts.api || env.OMMISA_API || DEFAULTS.api).replace(/\/+$/, ""),
    clientId: opts.clientId || env.OMMISA_CLIENT_ID || DEFAULTS.clientId,
    scope: opts.scope || env.OMMISA_SCOPE || DEFAULTS.scope,
  };
}

// ── the credential file ──────────────────────────────────────────────

export function credentialsPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ommisa", "credentials.json");
}

export function loadCredentials(env = process.env) {
  const p = credentialsPath(env);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function saveCredentials(creds, env = process.env) {
  const p = credentialsPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export function clearCredentials(env = process.env) {
  const p = credentialsPath(env);
  if (existsSync(p)) rmSync(p);
  return p;
}

// ── the local state file (non-secret: the last ask's quota echo) ─────

export function statePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ommisa", "state.json");
}

export function loadState(env = process.env) {
  const p = statePath(env);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state, env = process.env) {
  const p = statePath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
  return p;
}

// ── the token math ───────────────────────────────────────────────────

export function expired(creds, skewMs = 60_000) {
  return !creds?.access_token || (creds.expires_at != null && Date.now() + skewMs >= creds.expires_at);
}

/** Decode a JWT's payload WITHOUT verification — display only. The
 *  token's authority is the server's (the deployment introspects it at
 *  the OP); the CLI never trusts these claims for anything local. */
export function decodeJwtPayload(jwt) {
  const seg = String(jwt || "").split(".");
  if (seg.length !== 3) return null;
  try {
    const b64 = seg[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// ── RFC 8628 §3.1/§3.2 — the device authorization ────────────────────

export async function beginDeviceLogin(http, { issuer, clientId, scope }) {
  const res = await http(`${issuer}/op/device/authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.device_code) {
    const e = new Error(body.error_description || body.error || `the device authorization failed (HTTP ${res.status})`);
    e.code = body.error || "device_authorization_failed";
    throw e;
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RFC 8628 §3.5 — poll the token endpoint, honoring `interval` and
 *  adding 5s to the pace on `slow_down`. */
export async function pollDeviceToken(http, { issuer, clientId, deviceCode, interval, signal, sleepFn = sleep }) {
  let pace = Math.max(1, Number(interval) || 5) * 1000;
  for (;;) {
    if (signal?.aborted) {
      const e = new Error("cancelled");
      e.code = "cancelled";
      throw e;
    }
    await sleepFn(pace);
    const res = await http(`${issuer}/op/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) return body;
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      pace += 5_000;
      continue;
    }
    const e = new Error(body.error_description || body.error || `the token poll failed (HTTP ${res.status})`);
    e.code = body.error || "token_poll_failed";
    throw e;
  }
}

export async function openBrowser(url) {
  const { spawn } = await import("node:child_process");
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!opener) return false;
  try {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function login(opts = {}, hooks = {}) {
  const { env = process.env, http = fetch, sleepFn, stdout = () => {}, open = openBrowser } = hooks;
  const cfg = resolveConfig(opts, env);
  const begin = await beginDeviceLogin(http, cfg);
  stdout(`Sign in at ${begin.verification_uri}`);
  stdout(`Code: ${begin.user_code}`);
  stdout(`The code expires in ${Math.round((Number(begin.expires_in) || 600) / 60)} minutes. Asking every ${Math.round((Number(begin.interval) || 5))}s...`);
  if (open) open(begin.verification_uri_complete || begin.verification_uri).catch(() => {});
  const tokens = await pollDeviceToken(http, {
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    deviceCode: begin.device_code,
    interval: begin.interval,
    signal: hooks.signal,
    sleepFn,
  });
  const creds = {
    access_token: tokens.access_token,
    token_type: tokens.token_type || "Bearer",
    expires_at: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : null,
    refresh_token: tokens.refresh_token || null,
    id_token: tokens.id_token || null,
    scope: tokens.scope || cfg.scope,
    issuer: cfg.issuer,
    api: cfg.api,
    client_id: cfg.clientId,
    obtained_at: new Date().toISOString(),
  };
  const path = saveCredentials(creds, env);
  return { creds, path, claims: decodeJwtPayload(creds.id_token) };
}

// ── the refresh grant (RFC 6748 §6; the OP rotates — persist or lose) ─

export async function refreshTokens(http, { issuer, clientId }, creds, env = process.env) {
  if (!creds?.refresh_token) return creds;
  const res = await http(`${issuer}/op/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: clientId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) return creds;
  const next = {
    ...creds,
    access_token: body.access_token,
    expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    refresh_token: body.refresh_token || creds.refresh_token,
    id_token: body.id_token || creds.id_token,
    obtained_at: new Date().toISOString(),
  };
  saveCredentials(next, env);
  return next;
}

export async function ensureFresh(http, creds, env = process.env) {
  if (!expired(creds)) return creds;
  const cfg = resolveConfig({ issuer: creds?.issuer, clientId: creds?.client_id }, env);
  return refreshTokens(http, { issuer: cfg.issuer, clientId: cfg.clientId }, creds, env);
}

// ── the ask ──────────────────────────────────────────────────────────

export async function ask(http, { api, query, accessToken, signal, lang }) {
  const res = await http(`${api}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(lang ? { query, stream: false, lang } : { query, stream: false }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error_description || body.detail || body.error || `the ask failed (HTTP ${res.status})`);
    e.status = res.status;
    e.code = body.error;
    throw e;
  }
  return body;
}
