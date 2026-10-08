# AGENTS.md

Guidance for coding agents working on this repository. See `README.md` for the product overview.

## What this is

A push-to-talk voice input tool for amateur radio QSO logging. The ASR is used as a **lexer**; a small hand-written
parser interprets a QSO-specific DSL. There is no NLP/LLM in the pipeline, and there should not be.

- `web/`: SvelteKit 3 + Svelte 5 (runes) + TypeScript, built with `adapter-static` as a client-only SPA/PWA.
- `server/`: Rust (edition 2024) + axum 0.8 + sqlx (SQLite). Serves `web/build` and the API on one origin;
  passkey-only sign-in (webauthn-rs), per-user QSOs and stations, forwarding to each user's Wavelog (API v2).
  Also the admin CLI (`user ...`, `passkey bootstrap ...`).

## Commands

Run these before committing; CI (`.github/workflows/ci.yml`) runs the same.

```sh
cd web
npm ci
npm run lint        # prettier --check (indentation from .editorconfig, single quotes, width 100)
npm run check       # svelte-check / TypeScript
npm test            # vitest unit tests
npm run test:e2e    # Playwright (Chromium with fake microphone), the app alone
npm run test:e2e:server  # Playwright with the real server (cargo) and a virtual passkey authenticator

cd server
cargo fmt --check   # max_width = 120
cargo clippy --all-targets -- -D warnings
cargo test
```

`npm install` with npm 10 can crash (`Cannot read properties of null (reading 'edgesOut')`); use npm 11+
(`npx npm@11 install ...`). CI uses Node 24.

## Architecture rules

- **DSL logic is pure.** `web/src/lib/dsl/` (tokenizer, number words, parser, frequency resolver) and
  `web/src/lib/qso/` must not touch the DOM, audio, storage or network. Add unit tests next to the code (`*.test.ts`).
- **The lexicon is the single source of truth.** New words go into `web/src/lib/dsl/lexicon.ts`; the Vosk grammar is
  generated from it (`grammarPhrases()` in `web/src/lib/dsl/grammar.ts`), so the parser and the ASR never disagree.
  Spellings that only free-text input produces belong in `FREE_TEXT_ONLY_WORDS` so they stay out of the grammar.
  A new grammar word also needs its Japanese readings in `JAPANESE_READINGS` (the Japanese model's grammar and the
  tokenizer are built from them); the DSL the parser sees stays English.
- **No correction commands.** Speaking a field again overwrites the whole field. Utterances are all-or-nothing.
- **Frequency anchor ≠ current frequency.** Partial frequencies resolve against `OperatingSession.frequencyAnchorHz`
  only (`resolveFrequency`); never "keep the integer part of the current frequency".
- **JCX codes are strings** (leading zeros matter).
- **ASR engines stay behind `SpeechRecognizer`** (`web/src/lib/speech/recognizer.ts`). PCM is 16 kHz mono `Float32Array`
  produced by the AudioWorklet (`pcm-worklet.ts`), and audio only flows while PTT is held.
- **Local first.** LOG QSO writes to IndexedDB before any network call. Sync is idempotent (client UUID `id`;
  the server de-duplicates), so retries are always safe.
- **Secrets stay on the server.** The Wavelog API token must never be sent to or stored in the browser.
- **Passkeys only.** No passwords. A user's first passkey comes from a one-time `passkey bootstrap` link (refused once
  the user has a passkey); later ones are added from a signed-in session. Users are UUIDs internally (also the WebAuthn
  user handle) and shown as their callsign.
- **No CSRF tokens.** The session is a `__Host-` `SameSite=Lax` cookie, and state-changing requests must come from
  `PUBLIC_ORIGIN` (`same_origin_only` in `server/src/api.rs`). Keep it that way: tokens would go stale while
  QSOs wait offline.
- **Schema changes are migrations.** Add a file to `server/migrations/`; never edit an applied one.
- **Keep both ADIF writers in sync.** `web/src/lib/qso/adif.ts` and `server/src/adif.rs` render identical records; their
  tests share the same expected string. The same applies to the band tables and to the API payload
  (`QsoApiPayload` in `web/src/lib/qso/record.ts` ↔ `QsoPayload` in `server/src/qso.rs`).

## SvelteKit 3 notes

- Import library code with relative paths (`../lib/...`). The `#lib/*` subpath import maps to exact files only.
- `$app/paths` exports `asset()` and `resolve()` (no `base`); `$app/manifest` and `$app/service-worker` replace
  `$service-worker`. The service worker lives in `src/service-worker/` with its own `tsconfig.json`.
- The app is client-only (`ssr = false`, `prerender = true` in `src/routes/+layout.ts`) and served at the root of
  `PUBLIC_ORIGIN`; API calls use absolute `/api/...` paths. `npm run dev` proxies `/api` to `API_SERVER`.
- `window.__qso` exposes the `QsoApp` instance for on-device debugging and e2e tests
  (e.g. `__qso.useRecognizer(fake)`, `__qso.handleText('received five seven', 'typed')`).

## Style

- Match the surrounding code; comments explain _why_, not _what_.
- Rust modules with submodules are `foo.rs` next to `foo/`, not `foo/mod.rs`.
- Code comments, docs and UI text are in English (the DSL is English, too). Japanese is fine in test data,
  e.g. to exercise multi-byte ADIF field lengths.
- Commit in small, focused commits with descriptive messages.
