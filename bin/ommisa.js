#!/usr/bin/env node
// ommisa — the OIML Metrology Machine Intelligence SMART Assistant,
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
  askStream,
  uploadAttachment,
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
import { homedir } from "node:os";
import { join } from "node:path";

const out = (s) => process.stdout.write(s + "\n");
const errOut = (s) => process.stderr.write(s + "\n");

const HELP = `ommisa — the OIML SMART AI, as your signed-in self

  ommisa login [--read-only]     sign in through the browser (device code)
  ommisa status                  the account, the service, the quota
  ommisa ask "<question>"        ask (member tier by default; --public forces the anonymous tier)
      (piped stdin)              piped text becomes the question's context: cat spec.md | ommisa ask "summarize this"
      --json                     print the machine-readable response on stdout
      -o FILE                    write the answer (markdown) to a file
      --lang LL                  answer language (e.g. fr)
      --fresh                    bypass the answer caches
      --conversation ID          continue a stored conversation
      -c, --continue             continue the last stored conversation
      --save                     store this turn as a new conversation
      --attach FILE              put an image (PNG/JPEG/WebP/GIF, ≤4 MB) on this question
      --stream-json              NDJSON events on stdout (stage/token/done) for pipelines
      --timeout SEC              give up after SEC seconds (default 180)
      --no-md                    print raw markdown (the TTY render is on by default)

  Exit codes: 0 ok · 1 failed · 2 usage · 4 quota spent · 130 interrupted
  ommisa chat                    a thread in your terminal — /new /save /attach /lang /exit
  ommisa log [N]                 the last N asks from this machine's local log
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
    else if (a === "--public") opts.public = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-o" || a === "--output") opts.output = argv[++i];
    else if (a === "-c" || a === "--continue") opts.cont = true;
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
    else if (a === "--attach") opts.attach = argv[++i];
    else if (a === "--stream-json") opts.streamJson = true;
    else if (a === "--no-md") opts.noMd = true;
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

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function logPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ommisa", "log.jsonl");
}

// every ask lands in the local log — history for the signed-out, and
// the receipt `-c` and `ommisa log` read
async function logAsk(entry) {
  try {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(logPath()), { recursive: true });
    await appendFile(logPath(), JSON.stringify(entry) + "\n");
  } catch {
    /* the log never blocks an answer */
  }
}

const IMAGE_MIMES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

async function imageDataUrl(file) {
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(file);
  if (bytes.length > 4_000_000) throw Object.assign(new Error("the image exceeds 4 MB"), { usage: true });
  const h = bytes.subarray(0, 12);
  const magic = h[0] === 0x89 && h[1] === 0x50 ? "png"
    : h[0] === 0xff && h[1] === 0xd8 ? "jpg"
    : h.length >= 12 && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50 ? "webp"
    : h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 ? "gif" : null;
  if (!magic) throw Object.assign(new Error("only PNG, JPEG, WebP or GIF images are supported"), { usage: true });
  return `data:${IMAGE_MIMES[magic]};base64,${bytes.toString("base64")}`;
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
    let query = rest.join(" ").trim();
    if (!process.stdin.isTTY) {
      // chaining: `cat spec.md | ommisa ask "summarize this"` — the piped
      // text rides ahead of the question as its context
      const piped = await readAllStdin();
      if (piped.trim()) query = piped.trim() + "\n\n---\n\n" + query;
    }
    if (!query) {
      errOut('Usage: ommisa ask "<question>"   (or pipe text into it)');
      return 2;
    }
    let creds = opts.public ? null : loadCredentials();
    if (creds?.access_token) creds = await ensureFresh(fetch, creds);
    const member = !!creds?.access_token;
    if (opts.public) errOut("(--public — asking as an anonymous visitor)");
    const api = creds?.api || resolveConfig(opts).api;
    let history;
    let conversationId = opts.conversation || (opts.cont ? loadState().last_conversation : null) || null;
    if (opts.cont && !conversationId) errOut("No stored thread to continue yet — ask with --save first.");
    if (conversationId) {
      if (needAuth(loadCredentials())) return 1;
      let c0 = loadCredentials();
      const conv = await getConversation(fetch, creds?.api || resolveConfig(opts).api, c0?.access_token, conversationId);
      history = (conv.messages || []).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    }
    const quiet = !!opts.json || !!opts.streamJson; // machine mode: no chatter anywhere
    let image = opts.attach ? await imageDataUrl(opts.attach) : null;
    let attachmentIds;
    if (image && member) {
      // a member's photo persists (Tier-1) and later turns re-attach it (Tier-2)
      try {
        const id = await uploadAttachment(fetch, api, creds?.access_token, image);
        if (id) { attachmentIds = [id]; image = undefined; }
      } catch { /* the inline path still answers */ }
    }
    if (opts.attach && !image) errOut("(the image could not be read — asking without it)");
    const ndjson = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
    const { spinner, writeAnimated } = await import("../lib/ui.mjs");
    const spin = quiet
      ? { stage() {}, done() {} }
      : spinner();
    let streamedAny = false;
    let replyText = "";
    const writeToken = (v) => {
      if (!quiet) {
        if (streamedAny === false) {
          streamedAny = true;
          spin.done();
          process.stdout.write("\n");
        }
        process.stdout.write(v);
      }
      replyText += v;
    };

    opts.signal = AbortSignal.timeout((opts.timeout || 180) * 1000);
    let answer;
    try {
      answer = await askStream(fetch, {
        api,
        query,
        accessToken: creds?.access_token,
        lang: opts.lang,
        fresh: opts.fresh,
        history,
        image,
        attachmentIds,
        signal: opts.signal,
        onStage: opts.streamJson ? (l) => l != null && ndjson({ type: "stage", label: l }) : (l) => spin.stage(l),
        onToken: opts.streamJson ? (v) => ndjson({ type: "token", v }) : writeToken,
      });
      if (quiet) replyText = answer.answer ?? "";
    } catch (e) {
      spin.done();
      if (e.status === 401 && creds?.refresh_token) {
        const next = await refreshTokens(fetch, { issuer: creds.issuer, clientId: creds.client_id }, creds);
        if (next === creds) {
          errOut("The sign-in has expired. Run: ommisa login");
          return 1;
        }
        creds = next;
        answer = await askApi(fetch, { api, query, accessToken: creds.access_token, lang: opts.lang, fresh: opts.fresh, history, image, attachmentIds });
        if (quiet) replyText = answer.answer ?? "";
      } else if (e.status === 429) {
        if (opts.json) ndjson({ type: "error", error: { code: "quota_exhausted", message: e.message } });
        errOut("Today's quota is spent — the count resets tomorrow (UTC). `ommisa status` shows where you stand.");
        return 4;
      } else {
        throw e;
      }
    }
    spin.done();

    const reply = replyText || (answer.answer ?? "");
    // ── output ──
    if (opts.json) {
      // machine mode: the full response document on stdout; everything a
      // pipeline needs (answer, citations, confidence, quota) in one parse
      process.stdout.write(JSON.stringify({
        answer: reply,
        citations: answer.citations ?? [],
        source_quality: answer.source_quality ?? null,
        confidence_note: answer.confidence_note ?? null,
        experimental_sources: answer.experimental_sources ?? [],
        quota: answer.quota ?? null,
        model: answer.model ?? null,
        query_hash: answer.query_hash ?? null,
      }, null, 2));
    } else if (opts.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.output, reply.endsWith("\n") ? reply : reply + "\n");
      errOut(`Written to ${opts.output}.`);
    } else {
      // the reply block: framed by blank lines so the reply never touches
      // the status or the footer; whole-payload answers (cache hits arrive
      // as one blob) animate at speed so every reply reads as streaming
      process.stdout.write("\n");
      if (streamedAny) {
        // tokens already flowed
      } else if (process.stdout.isTTY && !opts.noMd) {
        const { renderMd } = await import("../lib/md.mjs");
        await writeAnimated(renderMd(reply, true));
      } else {
        await writeAnimated(reply);
      }
      process.stdout.write("\n\n");
    }

    if (opts.streamJson) {
      ndjson({ type: "done", answer: reply, citations: answer.citations ?? [], source_quality: answer.source_quality ?? null, confidence_note: answer.confidence_note ?? null, experimental_sources: answer.experimental_sources ?? [], quota: answer.quota ?? null, model: answer.model ?? null });
    }

    // ── the footer: messages and warnings ride stderr, under a rule ──
    if (!quiet) {
      errOut("─".repeat(32));
      const cites = answer.citations || [];
      if (cites.length) {
        cites.forEach((c, i) => {
          const id = String(c.docidentifier || c.doc_id || "source");
          const edition = c.edition && !id.includes(String(c.edition)) ? `:${c.edition}` : "";
          errOut(`  [${i + 1}] ${[id, edition, c.clause_anchor && !/^[0-9a-f]{8}-|^_/.test(c.clause_anchor) ? ` §${c.clause_anchor}` : ""].join("")}${c.language ? ` · ${c.language}` : ""}`);
        });
        errOut("─".repeat(32));
      }
      if (answer.source_quality === "ocr") {
        errOut("⚠ " + (answer.confidence_note || answer.quality_note || "WARNING: Partly grounded in experimental OCR data. Verify against official publications."));
        if (answer.experimental_sources?.length) errOut(`   Experimental sources: ${answer.experimental_sources.join("; ")}`);
      }
      if (!member) errOut("Public tier — `ommisa login` signs you in: 300 questions a day, your memory files and conversations.");
      if (answer.quota && typeof answer.quota.used === "number") {
        errOut(`Quota: ${answer.quota.used} / ${answer.quota.limit} today (${member ? "member" : "public"} tier).`);
        saveState({ ...loadState(), last_quota: { ...answer.quota, tier: member ? "member" : "anon", at: new Date().toISOString() } });
      }
    }

    logAsk({ at: new Date().toISOString(), query, answer: reply, citations: (answer.citations || []).map((c) => String(c.docidentifier || c.doc_id || c.label || "")).filter(Boolean).slice(0, 8), source_quality: answer.source_quality ?? null, model: answer.model ?? null, conversation: conversationId ?? null, tier: member ? "member" : "public" });

    if ((opts.save || conversationId) && member) {
      if (!/\bwrite\b/.test(creds.scope ?? "")) {
        errOut("This sign-in grants read only — the turn was not stored (re-run `ommisa login` for a write scope).");
      } else {
        try {
          if (!conversationId) {
            const created = await createConversation(fetch, api, creds.access_token, query.slice(0, 120));
            conversationId = created.id;
          }
          saveState({ ...loadState(), last_conversation: conversationId });
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

  // ── the local ask log ──────────────────────────────────────────────
  if (cmd === "log") {
    const { readFile } = await import("node:fs/promises");
    const txt = await readFile(logPath(), "utf8").catch(() => "");
    const rows = txt.trim() ? txt.trim().split("\n").map((l) => JSON.parse(l)) : [];
    if (!rows.length) {
      out("No asks logged yet — every `ommisa ask` lands here.");
      return 0;
    }
    const n = Math.max(1, Number(rest[0]) || 10);
    for (const r of rows.slice(-n)) {
      out(`${(r.at || "").slice(0, 16).replace("T", " ")}  [${r.tier || "?"}${r.source_quality === "ocr" ? " · ocr" : ""}]  ${String(r.query).slice(0, 72)}${String(r.query).length > 72 ? "…" : ""}`);
      out(`    ${String(r.answer).replace(/\s+/g, " ").slice(0, 100)}${String(r.answer).length > 100 ? "…" : ""}`);
      if (r.citations?.length) out(`    · ${r.citations.join("; ")}`);
    }
    return 0;
  }

  // ── the REPL: a thread that lives in the terminal ───────────────────
  if (cmd === "chat") {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
    const { spinner, writeAnimated } = await import("../lib/ui.mjs");
    let creds = opts.public ? null : loadCredentials();
    if (creds?.access_token) creds = await ensureFresh(fetch, creds);
    const member = !!creds?.access_token;
    const api = creds?.api || resolveConfig(opts).api;
    if (member) errOut(`Ommisa chat — ${claimName(decodeJwtPayload(creds.id_token) || {})} · /new clears the thread · /save stores it · /exit leaves.`);
    else errOut("Ommisa chat — the public tier; the thread lives only in this terminal. `ommisa login` adds memory and stored conversations.");
    let history = [];
    let lang = opts.lang;
    let pendingImage = opts.attach ? await imageDataUrl(opts.attach) : null;
    let pendingAttachmentId = pendingImage && member ? await uploadAttachment(fetch, api, creds?.access_token, pendingImage).catch(() => null) : null;
    for (;;) {
      let q;
      try {
        q = (await rl.question("› ")).trim();
      } catch {
        break; // Ctrl-C / Ctrl-D
      }
      if (!q) continue;
      if (q === "/exit" || q === "/quit" || q === "/q") break;
      if (q === "/new") {
        history = [];
        errOut("(a new thread)");
        continue;
      }
      if (q.startsWith("/lang ")) {
        lang = q.split(/\s+/)[1];
        errOut(`(answering in ${lang})`);
        continue;
      }
      if (q === "/save") {
        if (!history.length) { errOut("Nothing to store yet."); continue; }
        if (!member) { errOut("Storing conversations needs a member sign-in — `ommisa login`."); continue; }
        try {
          const created = await createConversation(fetch, api, creds.access_token, history[0].content.slice(0, 120));
          for (const m of history) await appendMessage(fetch, api, creds.access_token, created.id, m.role, m.content);
          errOut(`Stored as conversation ${created.id}.`);
        } catch (e) {
          errOut(`Storing failed: ${e.message}`);
        }
        continue;
      }
      if (q.startsWith("/attach ")) {
        try {
          pendingImage = await imageDataUrl(q.slice(8).trim());
          pendingAttachmentId = member ? await uploadAttachment(fetch, api, creds?.access_token, pendingImage) : null;
          errOut("(the image rides your next question — photos are seen only in the turn they accompany)");
        } catch (e) {
          errOut(`ommisa: ${e.message}`);
        }
        continue;
      }
      if (q === "/help") {
        errOut("/new clears the thread · /save stores it · /attach FILE puts an image on your next question · /lang LL answers in a language · /exit leaves. Anything else is a question.");
        continue;
      }
      const spin = spinner();
      let streamed = false;
      let reply = "";
      let answer = null;
      try {
        answer = await askStream(fetch, {
          api,
          query: q,
          accessToken: creds?.access_token,
          lang,
          fresh: opts.fresh,
          history: history.slice(-8),
          image: pendingAttachmentId ? undefined : pendingImage,
          attachmentIds: pendingAttachmentId ? [pendingAttachmentId] : undefined,
          signal: opts.signal,
          onStage: (l) => spin.stage(l),
          onToken: (v) => {
            if (!streamed) {
              streamed = true;
              spin.done();
              process.stdout.write("\n");
            }
            process.stdout.write(v);
            reply += v;
          },
        });
        if (!streamed) {
          reply = answer.answer ?? "";
          if (process.stdout.isTTY && !opts.noMd) {
            const { renderMd } = await import("../lib/md.mjs");
            await writeAnimated(renderMd(reply, true));
          } else {
            await writeAnimated(reply);
          }
        }
        process.stdout.write("\n\n");
        const cites = answer.citations || [];
        if (cites.length) {
          errOut(`  · ${cites.slice(0, 6).map((c) => [String(c.docidentifier || c.doc_id || "source"), c.clause_anchor && !/^[0-9a-f]{8}-|^_/.test(c.clause_anchor) ? ` §${c.clause_anchor}` : ""].join("")).join("; ")}${cites.length > 6 ? ` (+${cites.length - 6})` : ""}`);
        }
        if (answer.source_quality === "ocr") {
          errOut("⚠ " + (answer.confidence_note || answer.quality_note || "WARNING: Partly grounded in experimental OCR data. Verify against official publications."));
        }
        history.push({ role: "user", content: q }, { role: "assistant", content: reply });
        logAsk({ at: new Date().toISOString(), query: q, answer: reply, citations: (answer.citations || []).map((c) => String(c.docidentifier || c.doc_id || "")).filter(Boolean).slice(0, 8), source_quality: answer.source_quality ?? null, tier: member ? "member" : "public" });
        pendingImage = null;
        pendingAttachmentId = null;
      } catch (e) {
        spin.done();
        if (e.status === 429) errOut("Today's quota is spent — the count resets tomorrow (UTC).");
        else errOut(`ommisa: ${e.message}`);
      }
    }
    rl.close();
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
    if (e.usage) {
      errOut(`ommisa: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    errOut(`ommisa: ${e.message}`);
    process.exitCode = e.code === "cancelled" ? 130 : e.status === 429 ? 4 : 1;
  });
