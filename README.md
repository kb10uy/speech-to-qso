# speech-to-qso

A **push-to-talk voice input** web app for logging QSOs during portable operation. Hold the PTT button on your phone
and say things like "juliett lima one hotel india sierra" or "received five seven"; the matching fields of the draft
QSO are filled in. **LOG QSO** saves it locally (IndexedDB) and then syncs it to Wavelog through a small backend.

There is no natural language understanding. An off-the-shelf ASR is used as a **lexer**, and a hand-written parser
interprets a **QSO-specific DSL** with a deliberately small vocabulary and grammar.

- Web client: a SvelteKit + TypeScript PWA, served from GitHub Pages and usable offline
- Speech recognition: [Vosk](https://alphacephei.com/vosk/) WASM ([vosk-browser](https://github.com/ccoreilly/vosk-browser))
  running in the browser; the Web Speech API is available as an alternative
- Backend: a thin Rust + axum API that appends QSOs to local logs and forwards them to Wavelog

```
Hold PTT → getUserMedia → AudioWorklet (16 kHz mono) → Vosk WASM (Worker)
  → text → DSL parser → update draft QSO → check on screen → LOG QSO
  → save to IndexedDB → (when online) POST /api/qso → Wavelog
```

## Usage

1. Open https://kb10uy.github.io/speech-to-qso/ (add it to your home screen to install it as a PWA)
2. In the **Session** tab, save your operator callsign, operating location, frequency anchor and so on
3. In the **QSO** tab, press "Load speech engine" to load the speech model (about 40 MB, first time only)
4. Speak only while holding **HOLD TO TALK**; releasing it runs recognition → parsing → draft update
5. Check the result and press **LOG QSO**

What was heard and what changed are shown in the feedback line above the button
(`“received five seven” → RST received → 57`). If the ASR struggles, the same DSL can be typed under
"Type a command" (shorthands such as `jl1his`, `received 57` and `freq .94` also work).
On a desktop, the Space key works as PTT.

### Voice commands (DSL)

| Utterance                                              | Result                                              |
| ------------------------------------------------------ | --------------------------------------------------- |
| `juliett lima one hotel india sierra`                  | Callsign = `JL1HIS`                                 |
| `... stroke one` / `... portable one` / `... portable` | `JL1HIS/1` / `JL1HIS/1` / `JL1HIS/P`                |
| `sent five nine` (also `send`)                         | RST sent = `59`                                     |
| `received five seven` (also `receive`)                 | RST received = `57`                                 |
| `frequency point nine four`                            | Frequency `*.940` MHz → nearest to the anchor       |
| `frequency two point seven four`                       | `*2.740` MHz                                        |
| `frequency four thirty two point nine four`            | `432.940` MHz                                       |
| `jcx one zero zero one zero one` (also `jcc` / `jcg`)  | JCX = `"100101"` (a string; leading zeros are kept) |
| `card requested` / `no card`                           | QSL requested on / off                              |
| `mode foxtrot mike` / `mode fm`                        | Mode = `FM`                                         |

- **There are no correction commands.** Speaking a field again overwrites that whole field.
- Several commands can be chained in one PTT press (`juliett lima one hotel india sierra received five seven`).
  If any part fails to parse, the **whole utterance is discarded** (nothing is applied halfway).
- An utterance that does not start with a keyword is treated as a callsign (`call` / `callsign` may be prefixed).
- Numbers are read the way radio operators say them: `four thirty two` → `432`, `one forty five` → `145`,
  `double five` → `55`.
- RST defaults to `59 / 59`. Frequency and mode carry over to the next QSO.

### Frequency resolver

**Only the spoken digits are constraints; omitted higher-order digits are wildcards, and the candidate nearest to the
frequency anchor wins.**

```
anchor = 433.000 MHz
"frequency point nine four"      → *.940  → 432.940 (nearer than 433.940)
"frequency two point seven four" → *2.740 → 432.740
```

The anchor (set in the Session tab) is not the current frequency. Even if the rig is on 430.200 MHz, with an anchor of
433.000 `point nine four` resolves to 432.940. The implementation is a pure function in `web/src/lib/dsl/frequency.ts`.

## Sync and backend

LOG QSO **always saves to IndexedDB first**; syncing is a separate step, so a network failure never means a lost QSO.
The Log tab shows the state of each QSO (`local` / `waiting` / `synced` / `failed`), and unsynced QSOs are retried
automatically on startup and when the device comes back online. Without a backend you can still write an `.adi` file
with **Export ADIF** in the Log tab.

The backend (`server/`) is a thin API whose main job is keeping the Wavelog API key out of the browser.

```sh
cd server
cp .env.example .env   # edit, then export the variables
cargo run --release
```

| Environment variable | Description                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- |
| `LISTEN`             | Listen address (default `127.0.0.1:8080`)                                              |
| `API_TOKEN`          | Bearer token sent by the client (Settings → API token). Unset disables authentication  |
| `ALLOWED_ORIGINS`    | Comma-separated CORS origins, e.g. `https://kb10uy.github.io`. Empty allows any origin |
| `DATA_DIR`           | Where `qsos.jsonl` (event log) and `log.adi` (ADIF) are written (default `data`)       |
| `WAVELOG_URL`        | Base URL of your Wavelog, e.g. `https://log.example.com`                               |
| `WAVELOG_API_KEY`    | Wavelog API key (read/write)                                                           |
| `WAVELOG_STATION_ID` | Default station location id (can be overridden per session in the Session tab)         |

- GitHub Pages is served over HTTPS, so **the backend must be reachable over HTTPS too** (a reverse proxy such as
  Caddy or nginx is recommended).
- `POST /api/qso` de-duplicates by the client-generated UUID, so retries never create duplicates.
  If forwarding to Wavelog fails it returns 502, and only the forwarding is retried when the client resends.
- `GET /api/health` can be used to check connectivity.

### ADIF mapping

| QSO field          | ADIF                                              |
| ------------------ | ------------------------------------------------- |
| Callsign           | `CALL`                                            |
| Frequency          | `FREQ` (MHz), `BAND`                              |
| RST sent / rcvd    | `RST_SENT` / `RST_RCVD`                           |
| QSL requested      | `QSL_SENT:R` (the other station requested a card) |
| JCX                | `COMMENT` (`JCX 100101`), `APP_SPEECHTOQSO_JCX`   |
| Operator callsign  | `OPERATOR`, `STATION_CALLSIGN`                    |
| Operating location | `MY_CITY`                                         |
| Own JCC/JCG        | `APP_SPEECHTOQSO_MY_JCX`                          |
| POTA reference     | `MY_SIG=POTA`, `MY_SIG_INFO`, `MY_POTA_REF`       |

## Deployment (GitHub Pages)

Pushing to `main` builds and deploys the site with `.github/workflows/pages.yml` (it can also be run manually).

One-time repository setup:

- **Settings → Pages → Build and deployment → Source**: **GitHub Actions**
- **Settings → Environments → `github-pages` → Deployment branches and tags**: allow `main`

The build downloads the small English Vosk model (`vosk-model-small-en-us-0.15`), repacks it as a `.tar.gz` with a
single top-level directory (the layout vosk-browser expects) and ships it under `models/`. vosk-browser stores the
model in IndexedDB on first load, so it keeps working offline afterwards. To use a different model, set its `.tar.gz`
URL under "Vosk model URL" in Settings (the host must allow CORS).

## Development

```sh
cd web
npm install
npm run dev          # dev server (the microphone works over plain HTTP on localhost)
npm test             # unit tests (vitest)
npm run test:e2e     # e2e tests (Playwright / Chromium with a fake microphone)
npm run check        # svelte-check (type checking)
npm run lint         # prettier

cd ../server
cargo test
cargo clippy --all-targets -- -D warnings
```

To try Vosk locally, put the model at `web/static/models/vosk-model-small-en-us-0.15.tar.gz`
(same steps as "Fetch Vosk model" in `pages.yml`).

### Layout

```
web/                      SvelteKit PWA
  src/lib/dsl/            Voice DSL: tokenizer, number words, parser, frequency resolver (pure logic)
  src/lib/qso/            Draft QSO, OperatingSession, QsoRecord, ADIF, band table
  src/lib/speech/         AudioWorklet, microphone capture, SpeechRecognizer (Vosk / Web Speech API)
  src/lib/storage/        IndexedDB (QSO log, key-value store)
  src/lib/sync/           Backend sync client
  src/lib/app/            App state and the PTT → ASR → parser → draft pipeline
  src/lib/components/     Screens (QSO / Session / Log / Settings)
  src/service-worker/     Service worker for offline use
  e2e/                    Playwright tests
server/                   Rust + axum backend
```

## About the ASR

The ASR library sits behind the `SpeechRecognizer` interface (`web/src/lib/speech/recognizer.ts`), so switching from
Vosk to sherpa-onnx, Whisper or a server-side ASR only means implementing that interface.

- **Vosk grammar**: vosk-browser 0.0.8 accepts a grammar when creating a recognizer, so recognition is restricted to
  the DSL vocabulary (`grammarVocabulary()` in `web/src/lib/dsl/lexicon.ts`; can be disabled in Settings).
  Spellings missing from the model's vocabulary (e.g. `juliett`) are ignored by Vosk, and an alternative spelling of
  the same letter (`juliet`) is used instead.
- Vosk may finalize a segment at a pause in the middle of an utterance, so all results of one PTT press are joined
  into a single utterance.
- Recording continues for the `Release tail` (300 ms by default) after PTT is released, so the last word is not
  clipped.

## Possible next steps

- Evaluate ASR accuracy in real conditions (with rig audio playing). The QSO screen keeps a history of recognition
  results under "Recent utterances".
- Stronger vocabulary constraints (a vosk-browser fork, or hotword biasing with sherpa-onnx)
- Ship a local JCC/JCG list to show confirmations such as `JCX 100101 Minato, Tokyo`
