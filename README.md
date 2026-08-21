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

Claude Code runs natively as a terminal agent, driving the "Plan → Generate →
Heal" lifecycle:

1. **Plan** — break a feature request into one localized change.
2. **Generate** — implement it inside `GeneratedSandbox` in `src/App.tsx`,
   with an explicit `data-testid` on every interactive element.
3. **Heal** — run `kane-cli` against the live component. On failure, Claude
   reads the NDJSON trace and Kane's own root-cause verdict, patches the
   code, and re-runs until green — without guessing at what broke.

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
- Launches a real, headless, browser-driven pass against `GeneratedSandbox`
- Emits NDJSON (`--agent` flag) that `kane-bridge.mjs` streams to the UI
- Returns a self-diagnosed pass/fail verdict — including root-cause
  analysis when a run fails, which is what let Claude self-heal without
  manual debugging

## Running locally

```bash
npm install
npm run dev            # starts the Vite dev server on :5173
node kane-bridge.mjs   # in a second terminal — starts the Kane bridge on :8787

npx kane-cli login --oauth   # one-time auth, opens a browser
```

Then open `http://localhost:5173`, type a feature request (or leave it
blank to run the default counter-increment check), and click **Generate**.

## Building for deploy

```bash
npm run build   # outputs static assets to dist/
```

Deploy `dist/` to Vercel/Netlify as a static site. The bridge server is not
part of this build — it only runs locally.
