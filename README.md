# Ommisa CLI

`ommisa` — the OIML SMART AI at the command line (the `@ommisa/cli` npm
package; the web app lives at ai.oimlsmart.org — same account, same
answers, different surface).

`@ommisa/cli` — the OIML Metrology Machine Intelligence Standards
Assistant. Sign in once through the browser, then ask the estate's AI
service as your signed-in self: member-tier retrieval, your own corpora
cones, citation-grounded answers.

## Quickstart

```sh
npm install -g @ommisa/cli     # or: npx @ommisa/cli
ommisa login
ommisa ask "What is the MPE requirement for a load cell per OIML R 60?"
ommisa status
```

`ommisa login` starts the OAuth device grant (RFC 8628): it prints a
short code and opens `https://id.oimlsmart.org/op/device`. Approve the
code in the browser — the approval page re-judges the ask against your
account's live standing — and the CLI completes on its own.

Without signing in, `ommisa ask` still works — the public tier (a few
questions a day, the public OIML corpus). The member tier adds the
estate's internal corpora, your memory files, and stored conversations.

## Commands

| Command | What it does |
| --- | --- |
| `ommisa login [--read-only]` | Device-flow sign-in; tokens live under `~/.config/ommisa/credentials.json` (mode 0600). Default scope `oiml-ai:read oiml-ai:write`; `--read-only` drops the write scope. |
| `ommisa status` | The service health, the signed-in account, roles, scope, token expiry, and the day's quota (as of your last ask). |
| `ommisa ask "<question>"` | Asks `POST /api/ask`; prints the answer, its citations and the quota echo. `--lang fr` sets the language, `--fresh` bypasses the answer caches, `--conversation ID` continues a stored conversation, `--save` stores the turn as a new conversation. Signed-out it asks anonymously. |
| `ommisa memories` | List your memory files; `add "<name>" "<content>"`, `rm <id>`. Selected files join your asks as context. |
| `ommisa conversations` | List stored conversations; `show <id>` prints a transcript, `new "<title>"` creates one, `rm <id>` removes. |
| `ommisa files [project-id]` | List projects, or one project's files. |
| `ommisa whoami` | Decodes the sign-in token locally (name, subject, roles, scope, expiry). Display only — the service re-judges the token server-side. |
| `ommisa logout` | Removes the stored credentials. |

## Configuration

Environment overrides (each also takes a flag: `--issuer`, `--api`,
`--client-id`, `--scope`):

| Variable | Default |
| --- | --- |
| `OMMISA_ID` | `https://id.oimlsmart.org` |
| `OMMISA_API` | `https://ai.oimlsmart.org` |
| `OMMISA_CLIENT_ID` | `oiml-ommisa` |
| `OMMISA_SCOPE` | `oiml-ai:read oiml-ai:write` (the OP's PAT grammar) |

## How it stays safe

- **No secret.** The CLI is a registered PUBLIC client — secretless,
  application-class. Nothing on your machine can impersonate the
  service.
- **Reads only.** The access token is an opaque OP token; the AI service
  admits it through RFC 7662 introspection as a member-READ credential.
  Drafts, writes and live-data exchanges stay browser-session acts —
  the CLI structurally cannot perform them.
- **Revocation is immediate.** Deactivating the account, or denying the
  renewal at sign-in, ends the grant family at the OP; the introspection
  cache on the service lives 45 seconds.
- **Rotation is persisted.** The OP rotates the refresh token on every
  renewal; the CLI writes the successor before it is ever needed again
  (a one-time token, by design).

## Development

```sh
npm install        # no dependencies — this only wires up
npm test           # the suite stubs the wire; nothing leaves the machine
```

Node >= 18. Zero runtime dependencies.
