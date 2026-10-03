# AGENTS.md

Guidance for coding agents working on this repository. See `README.md` for the product overview.

## What this is

A push-to-talk voice input tool for amateur radio QSO logging. The ASR is used as a **lexer**; a small hand-written
parser interprets a QSO-specific DSL. There is no NLP/LLM in the pipeline, and there should not be.

- `web/`: SvelteKit 3 + Svelte 5 (runes) + TypeScript, built with `adapter-static` as a client-only SPA/PWA for GitHub Pages.
- `server/`: Rust (edition 2024) + axum 0.8. Thin API: `POST /api/qso` → append-only local logs → Wavelog.

## Commands

Run these before committing; CI (`.github/workflows/ci.yml`) runs the same.

```sh
cd web
npm ci
npm run lint        # prettier --check (tabs, single quotes, width 100)
npm run check       # svelte-check / TypeScript
npm test            # vitest unit tests
npm run test:e2e    # Playwright (Chromium with fake microphone); builds with BASE_PATH=/speech-to-qso

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
  A new grammar word also needs its katakana readings in `JAPANESE_READINGS` (the Japanese model's grammar and the
  tokenizer are built from them); the DSL the parser sees stays English.
- **No correction commands.** Speaking a field again overwrites the whole field. Utterances are all-or-nothing.
- **Frequency anchor ≠ current frequency.** Partial frequencies resolve against `OperatingSession.frequencyAnchorHz`
  only (`resolveFrequency`); never "keep the integer part of the current frequency".
- **JCX codes are strings** (leading zeros matter).
- **ASR engines stay behind `SpeechRecognizer`** (`web/src/lib/speech/recognizer.ts`). PCM is 16 kHz mono `Float32Array`
  produced by the AudioWorklet (`pcm-worklet.ts`), and audio only flows while PTT is held.
- **Local first.** LOG QSO writes to IndexedDB before any network call. Sync is idempotent (client UUID `id`;
  the server de-duplicates), so retries are always safe.
- **Secrets stay on the server.** The Wavelog API key must never be sent to or stored in the browser.
- **Keep both ADIF writers in sync.** `web/src/lib/qso/adif.ts` and `server/src/adif.rs` render identical records; their
  tests share the same expected string. The same applies to the band tables and to the API payload
  (`QsoApiPayload` in `web/src/lib/qso/record.ts` ↔ `QsoPayload` in `server/src/qso.rs`).

## SvelteKit 3 notes

- Import library code with relative paths (`../lib/...`). The `#lib/*` subpath import maps to exact files only.
- `$app/paths` exports `asset()` and `resolve()` (no `base`); `$app/manifest` and `$app/service-worker` replace
  `$service-worker`. The service worker lives in `src/service-worker/` with its own `tsconfig.json`.
- The app is client-only (`ssr = false`, `prerender = true` in `src/routes/+layout.ts`). `BASE_PATH` sets `paths.base`.
- `window.__qso` exposes the `QsoApp` instance for on-device debugging and e2e tests
  (e.g. `__qso.useRecognizer(fake)`, `__qso.handleText('received five seven', 'typed')`).

## Style

- Match the surrounding code; comments explain _why_, not _what_.
- Code comments, docs and UI text are in English (the DSL is English, too). Japanese is fine in test data,
  e.g. to exercise multi-byte ADIF field lengths.
- Commit in small, focused commits with descriptive messages.
