#!/usr/bin/env node
// ommisa — the OIML Metrology Machine Intelligence Standards Assistant,
// at the command line. Signs in through the estate OP's device grant
// (RFC 8628) and speaks for the signed-in member: asks, quota, memory
// files, conversations, project files. Signed-out, it still asks — the
// public tier.

import {
  login,
  ensureFresh,
  expired,
  loadCredentials,
  clearCredentials,
  decodeJwtPayload,
  refreshTokens,
  loadState,
  saveState,
  resolveConfig,
  DEFAULTS,
} from "../lib/core.mjs";
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

const out = (s) => process.stdout.write(s + "\n");
const errOut = (s) => process.stderr.write(s + "\n");

const HELP = `ommisa — the OIML SMART AI, as your signed-in self

  ommisa login [--read-only]     sign in through the browser (device code)
  ommisa status                  the account, the service, the quota
  ommisa ask "<question>"        ask (signed-in member tier, or the public tier)
      --lang LL                  answer language (e.g. fr)
      --fresh                    bypass the answer caches
      --conversation ID          continue a stored conversation
      --save                     store this turn as a new conversation
  ommisa memories                list your memory files
  ommisa memories add "<name>" "<content>"
  ommisa memories rm <id>
  ommisa conversations           list your conversations
  ommisa conversations show <id>     print a conversation's transcript
  ommisa conversations new "<title>" create one (prints the id)
  ommisa conversations rm <id>
  ommisa files [project-id]      list projects, or one project's files
  ommisa whoami                  the signed-in account, from the sign-in token
  ommisa logout                  forget this machine's sign-in

Configuration (environment overrides; flags --issuer --api --client-id --scope):

  OMMISA_ID          the identity service   (default ${resolveConfig().issuer})
  OMMISA_API         the AI service         (default ${resolveConfig().api})
  OMMISA_CLIENT_ID   the device client      (default ${resolveConfig().clientId})
  OMMISA_SCOPE       the requested scopes   (default ${resolveConfig().scope})
`;

function parseArgv(argv) {
  const cmd = [];
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issuer") opts.issuer = argv[++i];
    else if (a === "--api") opts.api = argv[++i];
    else if (a === "--client-id") opts.clientId = argv[++i];
    else if (a === "--scope") opts.scope = argv[++i];
    else if (a === "--lang") opts.lang = argv[++i];
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "--conversation") opts.conversation = argv[++i];
    else if (a === "--save") opts.save = true;
    else if (a === "--read-only") opts.readOnly = true;
    else if (cmd.length === 0 && !a.startsWith("-")) cmd.push(a);
    else rest.push(a);
  }
  return { cmd: cmd[0], opts, rest };
}

function needAuth(creds) {
  if (!creds?.access_token) {
    errOut("Not signed in. Run: ommisa login");
    return true;
  }
  return false;
}

function claimName(claims) {
  return claims?.name || claims?.preferred_username || claims?.email || claims?.sub || "the account";
}

async function main() {
  const { cmd, opts, rest } = parseArgv(process.argv.slice(2));
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(HELP);
    return 0;
  }

  // ── the sign-in lifecycle ──────────────────────────────────────────
  if (cmd === "login") {
    const scope = opts.scope || (opts.readOnly ? DEFAULTS.readOnlyScope : DEFAULTS.scope);
    const { creds, path, claims } = await login({ ...opts, scope }, { stdout: out });
    // the OP's device grant mints a personal access token — the response
    // carries no id_token, so the honest display is the subject (a name
    // lights up here automatically if the OP ever adds claims)
    out(`Signed in — account ${claims?.name || claims?.preferred_username || creds.access_token.slice(0, 9) + "…"}. Credentials: ${path}`);
    const writable = /\bwrite\b/.test(creds.scope ?? "");
    out(`Scope: ${creds.scope}${writable ? "" : " (read only — memory and conversation writes are refused)"}`);
    return 0;
  }

  if (cmd === "logout") {
    const p = clearCredentials();
    out(p ? `Removed ${p}.` : "Already signed out.");
    return 0;
  }

  if (cmd === "whoami" || cmd === "status") {
    const cfg = resolveConfig(opts);
    let h = null;
    try {
      h = await health(fetch, cfg.api);
    } catch {
      /* reported below */
    }
    if (cmd === "status") {
      out(`service:   ${cfg.api}${h ? ` — ok${h.index_version ? `, index ${h.index_version}` : ""}` : " — UNREACHABLE"}`);
    }
    let creds = loadCredentials();
    if (!creds?.access_token) {
      out("account:   not signed in — the public tier (a few questions a day, the public OIML corpus). `ommisa login` for the member tier.");
      return 0;
    }
    creds = await ensureFresh(fetch, creds);
    const claims = decodeJwtPayload(creds.id_token) || {};
    out(`account:   ${claimName(claims)}${claims.name ? "" : ` (${creds.access_token.slice(0, 9)}… — the device grant mints a nameless personal token)`}`);
    if (cmd === "status") {
      out(`subject:   ${claims.sub || "(not stated)"}`);
      out(`roles:     ${(claims.roles || []).join(", ") || "(none)"}`);
      out(`scope:     ${creds.scope}`);
      out(`token:     ${creds.expires_at ? `expires ${new Date(creds.expires_at).toISOString()}` : "expiry unknown"}${expired(creds) ? " EXPIRED" : ""}`);
      const q = loadState().last_quota;
      out(
        q
          ? `quota:     ${q.used} / ${q.limit} questions today (${q.tier}, as of ${q.at})`
          : "quota:     no ask yet today — the count appears with your first answer",
      );
    }
    return 0;
  }

  // ── the ask ────────────────────────────────────────────────────────
  if (cmd === "ask") {
    const query = rest.join(" ").trim();
    if (!query) {
      errOut('Usage: ommisa ask "<question>"');
      return 2;
    }
    let creds = loadCredentials();
    if (creds?.access_token) creds = await ensureFresh(fetch, creds);
    const member = !!creds?.access_token;
    const api = creds?.api || resolveConfig(opts).api;
    errOut(`Asking ${api}${member ? "" : " (public tier — ommisa login for the member tier)"} (this can take half a minute)...`);

    let history;
    let conversationId = opts.conversation || null;
    if (conversationId) {
      if (needAuth(creds)) return 1;
      const conv = await getConversation(fetch, api, creds.access_token, conversationId);
      history = (conv.messages || []).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    }

    let answer;
    try {
      answer = await askApi(fetch, { api, query, accessToken: creds?.access_token, lang: opts.lang, fresh: opts.fresh, history });
    } catch (e) {
      if (e.status === 401 && creds?.refresh_token) {
        const next = await refreshTokens(fetch, { issuer: creds.issuer, clientId: creds.client_id }, creds);
        if (next === creds) {
          errOut("The sign-in has expired. Run: ommisa login");
          return 1;
        }
        creds = next;
        answer = await askApi(fetch, { api, query, accessToken: creds.access_token, lang: opts.lang, fresh: opts.fresh, history });
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
        // the client's citationLabel rule: the edition appends only when
        // the identifier does not already carry it ("R 60:2021" + "2021"
        // must not read "R 60:2021:2021")
        const id = String(c.docidentifier || c.doc_id || "source");
        const edition = c.edition && !id.includes(String(c.edition)) ? `:${c.edition}` : "";
        const label = [id, edition, c.clause_anchor ? ` §${c.clause_anchor}` : ""].join("");
        out(`  [${i + 1}] ${label}${c.language ? ` · ${c.language}` : ""}`);
        if (c.clause_title) out(`      ${c.clause_title}`);
      });
    }
    if (answer.quota && typeof answer.quota.used === "number") {
      out("");
      out(`Quota: ${answer.quota.used} / ${answer.quota.limit} questions today (${member ? "member" : "public"} tier).`);
      saveState({ ...loadState(), last_quota: { ...answer.quota, tier: member ? "member" : "anon", at: new Date().toISOString() } });
    }

    if ((opts.save || conversationId) && member) {
      if (!/\bwrite\b/.test(creds.scope ?? "")) {
        errOut("This sign-in grants read only — the turn was not stored (re-run `ommisa login` for a write scope).");
      } else {
        try {
          if (!conversationId) {
            const created = await createConversation(fetch, api, creds.access_token, query.slice(0, 120));
            conversationId = created.id;
          }
          await appendMessage(fetch, api, creds.access_token, conversationId, "user", query);
          await appendMessage(fetch, api, creds.access_token, conversationId, "assistant", answer.answer ?? "", cites.slice(0, 16));
          out(`Stored in conversation ${conversationId}.`);
        } catch (e) {
          errOut(`The answer stands, but storing it failed: ${e.message}`);
        }
      }
    }
    return 0;
  }

  // ── memory files ───────────────────────────────────────────────────
  if (cmd === "memories") {
    if (needAuth(loadCredentials())) return 1;
    let creds = loadCredentials();
    creds = await ensureFresh(fetch, creds);
    const api = creds.api;
    if (rest[0] === "add") {
      const [name, ...content] = rest.slice(1);
      if (!name || !content.join(" ").trim()) {
        errOut('Usage: ommisa memories add "<name>" "<content>"');
        return 2;
      }
      const r = await createMemory(fetch, api, creds.access_token, name, content.join(" "));
      out(`Memory file ${r.id} stored.`);
      return 0;
    }
    if (rest[0] === "rm") {
      if (!rest[1]) {
        errOut("Usage: ommisa memories rm <id>");
        return 2;
      }
      await deleteMemory(fetch, api, creds.access_token, rest[1]);
      out("Removed.");
      return 0;
    }
    const { memories } = await listMemories(fetch, api, creds.access_token);
    if (!memories?.length) {
      out("No memory files yet — `ommisa memories add \"<name>\" \"<content>\"` starts one. Selected files join your asks as context.");
      return 0;
    }
    for (const m of memories) {
      out(`${m.id}  ${m.enabled ? "" : "[disabled] "}${m.name}  ${String(m.content || "").slice(0, 60).replace(/\n/g, " ")}${(m.content || "").length > 60 ? "…" : ""}`);
    }
    return 0;
  }

  // ── conversations ──────────────────────────────────────────────────
  if (cmd === "conversations") {
    if (needAuth(loadCredentials())) return 1;
    let creds = loadCredentials();
    creds = await ensureFresh(fetch, creds);
    const api = creds.api;
    const sub = rest[0];
    if (sub === "new") {
      const title = rest.slice(1).join(" ") || "Conversation";
      const r = await createConversation(fetch, api, creds.access_token, title.slice(0, 120));
      out(r.id);
      return 0;
    }
    if (sub === "show") {
      if (!rest[1]) {
        errOut("Usage: ommisa conversations show <id>");
        return 2;
      }
      const conv = await getConversation(fetch, api, creds.access_token, rest[1]);
      out(`# ${conv.conversation?.title || conv.conversation?.id || rest[1]}`);
      for (const m of conv.messages || []) {
        out("");
        out(`${m.role === "user" ? "you" : "ommisa"}: ${m.content}`);
        if (m.citations?.length) {
          out(`   [${m.citations.map((c) => c.docidentifier || c.doc_id || c.label).filter(Boolean).join("; ")}]`);
        }
      }
      return 0;
    }
    if (sub === "rm") {
      if (!rest[1]) {
        errOut("Usage: ommisa conversations rm <id>");
        return 2;
      }
      await deleteConversation(fetch, api, creds.access_token, rest[1]);
      out("Removed.");
      return 0;
    }
    const { conversations } = await listConversations(fetch, api, creds.access_token);
    if (!conversations?.length) {
      out("No conversations yet — `ommisa ask \"<question>\" --save` starts one.");
      return 0;
    }
    for (const c of conversations) {
      out(`${c.id}  ${c.updated_at ? new Date(c.updated_at).toISOString().slice(0, 16).replace("T", " ") : ""}  ${c.title || "(untitled)"} (${c.messages} messages)`);
    }
    return 0;
  }

  // ── projects and their files ───────────────────────────────────────
  if (cmd === "files") {
    if (needAuth(loadCredentials())) return 1;
    let creds = loadCredentials();
    creds = await ensureFresh(fetch, creds);
    const api = creds.api;
    if (rest[0]) {
      const { files } = await listProjectFiles(fetch, api, creds.access_token, rest[0]);
      if (!files?.length) {
        out("No files in this project.");
        return 0;
      }
      for (const f of files) out(`${f.id}  ${f.name}  ${String(f.content || "").slice(0, 60).replace(/\n/g, " ")}${(f.content || "").length > 60 ? "…" : ""}`);
      return 0;
    }
    const { projects } = await listProjects(fetch, api, creds.access_token);
    if (!projects?.length) {
      out("No projects — projects live in the web app (they bind conversations and files into one context).");
      return 0;
    }
    for (const p of projects) out(`${p.id}  ${p.name} (${p.file_count} files, ${p.conversation_count} conversations)`);
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
