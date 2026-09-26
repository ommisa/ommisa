#!/usr/bin/env node
// ommisa — the OIML Metrology Machine Intelligence Standards Assistant,
// at the command line. Signs in through the estate OP's device grant
// (RFC 8628), asks the estate's AI service as the signed-in member.

import { login, ensureFresh, ask, loadCredentials, clearCredentials, decodeJwtPayload, refreshTokens, resolveConfig } from "../lib/core.mjs";

const HELP = `ommisa — ask the OIML SMART AI as your signed-in self

  ommisa login                 sign in through the browser (device code)
  ommisa ask "<question>"      ask; the answer carries its citations
  ommisa whoami                the signed-in account, from the sign-in token
  ommisa logout                forget this machine's sign-in

Configuration (environment overrides):

  OMMISA_ID          the identity service   (default ${resolveConfig().issuer})
  OMMISA_API         the AI service         (default ${resolveConfig().api})
  OMMISA_CLIENT_ID   the device client      (default ${resolveConfig().clientId})
  OMMISA_SCOPE       the requested scopes   (default ${resolveConfig().scope})
`;

const out = (s) => process.stdout.write(s + "\n");
const errOut = (s) => process.stderr.write(s + "\n");

function parseArgv(argv) {
  const cmd = argv[0];
  const opts = {};
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issuer") opts.issuer = argv[++i];
    else if (a === "--api") opts.api = argv[++i];
    else if (a === "--client-id") opts.clientId = argv[++i];
    else if (a === "--scope") opts.scope = argv[++i];
    else rest.push(a);
  }
  return { cmd, opts, rest };
}

async function main() {
  const { cmd, opts, rest } = parseArgv(process.argv.slice(2));
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(HELP);
    return 0;
  }

  if (cmd === "login") {
    const { creds, path, claims } = await login(opts, { stdout: out });
    const name = claims?.name || claims?.preferred_username || claims?.email || creds.sub || "the account";
    out(`Signed in as ${name}. Credentials: ${path}`);
    return 0;
  }

  if (cmd === "whoami") {
    const creds = loadCredentials();
    if (!creds?.access_token) {
      errOut("Not signed in. Run: ommisa login");
      return 1;
    }
    const claims = decodeJwtPayload(creds.id_token) || {};
    out(`name:      ${claims.name || claims.preferred_username || "(not stated)"}`);
    out(`subject:   ${claims.sub || "(not stated)"}`);
    out(`roles:     ${(claims.roles || []).join(", ") || "(none)"}`);
    out(`scope:     ${creds.scope}`);
    out(`expires:   ${creds.expires_at ? new Date(creds.expires_at).toISOString() : "(unknown)"}`);
    out(`service:   ${creds.api}`);
    return 0;
  }

  if (cmd === "logout") {
    const p = clearCredentials();
    out(p ? `Removed ${p}.` : "Already signed out.");
    return 0;
  }

  if (cmd === "ask") {
    const query = rest.join(" ").trim();
    if (!query) {
      errOut('Usage: ommisa ask "<question>"');
      return 2;
    }
    let creds = loadCredentials();
    if (!creds?.access_token) {
      errOut("Not signed in. Run: ommisa login");
      return 1;
    }
    creds = await ensureFresh(fetch, creds);
    errOut(`Asking ${creds.api} (this can take half a minute)...`);
    let answer;
    try {
      answer = await ask(fetch, { api: creds.api, query, accessToken: creds.access_token });
    } catch (e) {
      if (e.status === 401) {
        // one refresh attempt before giving up honestly
        const next = await refreshTokens(fetch, { issuer: creds.issuer, clientId: creds.client_id }, creds);
        if (next !== creds) {
          answer = await ask(fetch, { api: creds.api, query, accessToken: next.access_token });
        } else {
          errOut("The sign-in has expired. Run: ommisa login");
          return 1;
        }
      } else {
        throw e;
      }
    }
    out(answer.answer ?? "(the service returned no answer)");
    const cites = answer.citations || [];
    if (cites.length) {
      out("");
      out("Citations:");
      cites.forEach((c, i) => {
        const label = c.label || c.doc || c.title || c.id || `source ${i + 1}`;
        const uri = c.url || c.uri ? ` — ${c.url || c.uri}` : "";
        out(`  [${i + 1}] ${label}${uri}`);
      });
    }
    return 0;
  }

  errOut(`Unknown command: ${cmd}\n${HELP}`);
  return 2;
}

main()
  .then((code) => process.exitCode = code)
  .catch((e) => {
    errOut(`ommisa: ${e.message}`);
    process.exitCode = e.code === "cancelled" ? 130 : 1;
  });
