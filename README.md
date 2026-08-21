# Prompt-to-Feature Visual Playground

A developer utility that closes the loop between describing a feature and
verifying it actually works: describe a change, generate it, and have
[Kane CLI](https://www.testmuai.com/support/docs/kane-cli-introduction)
drive a real browser against the running app to confirm it — pass or fail,
with evidence.

**Live preview (UI only):** https://kaneloop-ai.vercel.app
> The deployed preview renders the full interface (prompt input, Plan /
> Generate / Verify status tracker, log console, `GeneratedSandbox`), but
> Kane CLI needs a local process to spawn a real browser — that can't run on
> a static host. Clicking Generate there will report the bridge as
> unreachable. **Run locally (below) to see the live verification loop.**

## Architecture

```
┌─────────────┐   spawns kane-cli    ┌──────────────┐   drives browser   ┌────────────────────┐
│  App.tsx UI │ ───(SSE, /run)────►  │ kane-bridge  │ ───(headless)────► │ GeneratedSandbox    │
│ (React)     │ ◄──NDJSON stream──── │  .mjs (Node) │ ◄──pass/fail───────│ localhost:5173      │
└─────────────┘                      └──────────────┘                    └────────────────────┘
```

- **`src/App.tsx`** — the playground: a prompt input, a Plan/Generate/Verify
  status tracker, a scrollable NDJSON log console, and `GeneratedSandbox` —
  the component under test, isolated in its own bordered card.
- **`src/kaneEvents.ts`** — parses one line of Kane's `--agent` NDJSON output
  into a log line + status-tracker patch. Deliberately transport-agnostic:
  the same parser is used for both file replay and the live stream.
- **`kane-bridge.mjs`** — a small local Node/HTTP server. `GET /run` accepts
  one or more objectives, spawns `kane-cli` directly via `node` (no shell,
  to avoid injecting untrusted prompt text into a shell command), and
  streams its NDJSON stdout back to the browser over Server-Sent Events.

## Agent Strategy: Claude Code

Claude Code drives the "Plan → Generate → Heal" lifecycle, and the Heal step
is **fully automatic — no terminal command, no human re-prompt**:

1. **Plan** — break a feature request into one localized change.
2. **Generate** — implement it inside `GeneratedSandbox` in `src/App.tsx`,
   with an explicit `data-testid` on every interactive element.
3. **Heal** — `kane-bridge.mjs` runs `kane-cli` against the live component
   and watches its NDJSON stream. The instant a `run_end` event reports
   `status: "failed"`, the bridge itself — not a person — spawns
   `claude -p` non-interactively with Kane's failure report and the
   current `src/App.tsx` piped in, has it patch the file, then re-runs
   `kane-cli` automatically. This repeats (capped at 2 attempts) until the
   run passes or the cap is hit — zero keystrokes between "Generate
   clicked" and "fixed and re-verified." See `runHeal` and the
   `runEnd?.status === 'failed'` check in `kane-bridge.mjs`.

This loop was used on itself during development: two live verification runs
initially failed for a real reason (Kane's browser agent reordered a
"read-before-click" instruction inside a single prose objective, verified by
Kane's own diagnostic with 0.93 confidence). The fix was structural — split
the assertion into two independently-ordered `kane-cli run` processes — not
a prompt-wording tweak, and it was re-verified with two consecutive passing
runs before being considered reliable. See `kane-bridge.mjs`'s handling of
`?steps=` for the fix.

## Verification Strategy: Kane CLI

Kane CLI is the verification layer, not a mock. It:

- Parses plain-English behavioral criteria (`kane-cli run "<objective>"`)
- Launches a real, headless, browser-driven pass against the target page
- Emits NDJSON (`--agent` flag) that `kane-bridge.mjs` streams to the UI
- Returns a self-diagnosed pass/fail verdict — including root-cause
  analysis when a run fails, which is what let Claude self-heal without
  manual debugging

The **Target URL** field isn't limited to `GeneratedSandbox` — point it at
any `http://` or `https://` site (your own machine, another device on your
network, or a public URL) and Kane will verify that instead. The bridge
validates the target server-side before spawning anything: localhost and
private-network ranges (10.x, 192.168.x, 172.16–31.x) are allowed, since
testing your own machine or LAN is the point; link-local addresses
(169.254.x, including cloud metadata endpoints like `169.254.169.254`) are
blocked, since that range has no legitimate use as a test target and is a
common SSRF probe vector.

## Security

This bridge spawns real processes (`kane-cli`, `claude -p` with file-edit
access) from HTTP requests, so it's hardened against being driven by
anything other than its own frontend — all of the following are verified
live, not just written:

- **Origin allowlist** — only requests from `localhost:5173`/`127.0.0.1:5173`
  are accepted; any other page open in the same browser gets a 403.
- **Concurrency cap** — a second simultaneous `/run` request gets a 429,
  so nothing can queue up unbounded Kane/Claude processes.
- **Content-hash diff-guard on Heal** — before and after every `claude -p`
  invocation, every file's hash is snapshotted; anything that changed
  outside `src/App.tsx` is automatically reverted (or deleted, if newly
  created). This was adversarially tested and initially found broken twice
  (filename-only diffing missed edits to already-dirty files; the revert
  logic deleted instead of restoring pre-existing files) before landing on
  the current implementation.
- **URL allowlist** on the Target URL feature (see above).

## Running locally

```bash
npm install
npx kane-cli login --oauth   # one-time auth, opens a browser

npm run start   # starts both the dev server and the Kane bridge, then
                 # opens http://localhost:5173 automatically
```

`npm run start` (`start.mjs`) is the one-command path: it launches the Vite
dev server and `kane-bridge.mjs` together, waits for both to come up, and
opens your browser to the app — no juggling two terminals.

If you'd rather run them separately (e.g. to see each server's own logs):

```bash
npm run dev             # terminal 1 — Vite dev server on :5173
node kane-bridge.mjs    # terminal 2 — Kane bridge on :8787
```

Then open `http://localhost:5173`, type a feature request (or leave it
blank to run the default counter-increment check), and click **Generate**.

## Building for deploy

```bash
npm run build   # outputs static assets to dist/
```

Deploy `dist/` to Vercel/Netlify as a static site. The bridge server is not
part of this build — it only runs locally.
