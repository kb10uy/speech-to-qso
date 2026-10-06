# speech-to-qso

A **push-to-talk voice input** web app for logging QSOs during portable operation. Hold the PTT button on your phone
and say things like "juliett lima one hotel india sierra" or "received five seven"; the matching fields of the draft
QSO are filled in. **LOG QSO** saves it locally (IndexedDB) and then syncs it to Wavelog through a small backend.

There is no natural language understanding. An off-the-shelf ASR is used as a **lexer**, and a hand-written parser
interprets a **QSO-specific DSL** with a deliberately small vocabulary and grammar.

- Web client: a SvelteKit + TypeScript PWA, usable offline
- Speech recognition: [Vosk](https://alphacephei.com/vosk/) WASM ([vosk-browser](https://github.com/ccoreilly/vosk-browser))
  running in the browser, restricted to the DSL vocabulary by a grammar
- Server: Rust + axum. Serves the app and its API on one origin, signs users in with passkeys, keeps each user's
  QSOs in SQLite and forwards them to their Wavelog

```
Hold PTT → getUserMedia → AudioWorklet (16 kHz mono) → Vosk WASM (Worker)
  → text → DSL parser → update draft QSO → check on screen → LOG QSO
  → save to IndexedDB → (when online) POST /api/qso → Wavelog
```

## Usage

1. Open your server's URL (add it to your home screen to install it as a PWA). The first time, open the setup link
   you were given (see [Users and passkeys](#users-and-passkeys)) to create your passkey
2. In **Settings**, connect Wavelog or add a station by hand. In the **Session** tab, pick the station (its callsign,
   location, POTA reference and own JCC/JCG become the defaults), then set the frequency anchor and so on
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
| `card requested` / `card negative`                     | QSL requested on / off                              |
| `card one way`                                         | QSL one way (they send a card, we send none)        |
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

## Sync and the server

LOG QSO **always saves to IndexedDB first**; syncing is a separate step, so a network failure never means a lost QSO.
The Log tab shows the state of each QSO (`local` / `waiting` / `synced` / `failed`), and unsynced QSOs are retried
automatically on startup and when the device comes back online. Without signing in, the app still works and
**Export ADIF** in the Log tab writes an `.adi` file of the QSOs on the device.

The server (`server/`) serves the built app and its API on one origin. Users sign in with passkeys only; QSOs are
stored per user in SQLite and forwarded to the user's Wavelog. Wavelog API tokens stay on the server.

```sh
cd server
cp .env.example .env   # edit, then export the variables
cargo run --release -- serve
```

| Environment variable | Description                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`      | URL the app is reached at, e.g. `https://qso.example.com`. Passkeys are bound to its host |
| `LISTEN`             | Listen address (default `127.0.0.1:8080`)                                                 |
| `WEB_DIR`            | The built app (`web/build`, see [Deployment](#deployment)). Without it only the API runs  |
| `DATABASE_PATH`      | SQLite database (default `data/speech-to-qso.db`)                                         |

- Passkeys need HTTPS (or `http://localhost`); put a TLS-terminating reverse proxy such as Caddy or nginx in front.
- **Do not change `PUBLIC_ORIGIN` once passkeys exist**: they only work on the host they were created for.
- The session is a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 60 days, extended while used).
  State-changing requests from other origins are rejected by checking `Origin` / `Sec-Fetch-Site`, so there are no
  CSRF tokens to go stale while QSOs wait offline.
- `POST /api/qso` de-duplicates by the client-generated UUID (per user), so retries never create duplicates.
  If forwarding to Wavelog fails it returns 502, and only the forwarding is retried when the client resends.
- `GET /api/qso.adi` downloads the user's whole log as ADIF ("Download the server log" in the Log tab).

### Users and passkeys

There is no password and no sign-up page. Users are created on the server, and their first passkey is registered
through a one-time link:

```sh
speech-to-qso-server user create JJ1ABC
speech-to-qso-server passkey bootstrap JJ1ABC            # prints https://qso.example.com/#bootstrap=...
speech-to-qso-server passkey bootstrap JJ1ABC --expires 1h
```

The link works once, expires (10 minutes by default) and is refused as soon as the user has a passkey. More passkeys
(one per device or password manager) are added from Settings while signed in. The app shows users by callsign;
internally they are UUIDs, which are also the passkeys' user handle, so `user rename JJ1ABC JJ1ABC/1` keeps every
passkey working.

Lost every device? Revoke the passkeys (this also ends the user's sessions) and issue a new link:

```sh
speech-to-qso-server passkey list JJ1ABC
speech-to-qso-server passkey revoke JJ1ABC <id>
speech-to-qso-server passkey revoke JJ1ABC --all
speech-to-qso-server passkey bootstrap JJ1ABC
```

### Wavelog and stations

Settings → Wavelog takes the Wavelog URL and an API v2 token (Wavelog 3.1.0 or later) with the `station:read` and
`qso:write` scopes. The server checks it by fetching the station locations and keeps a copy of them; **Refresh
stations** fetches them again. Users without Wavelog add stations by hand instead (their QSOs are only stored on the
server).

Each device picks its station in the Session tab; until it does, the user's default station (chosen in Settings,
initially the active Wavelog station) is used. Picking a station fills in the session: station callsign, location
(`city`), POTA reference (`pota`) and own JCC/JCG (`cnty`), which can still be edited. QSOs are forwarded with the
station's Wavelog id as `station_profile_id`. The operator callsign may be left empty: Wavelog then fills in the token
owner's callsign, and the app's own ADIF records leave `OPERATOR` out.

### ADIF mapping

| QSO field          | ADIF                                              |
| ------------------ | ------------------------------------------------- |
| Callsign           | `CALL`                                            |
| Frequency          | `FREQ` (MHz), `BAND`                              |
| RST sent / rcvd    | `RST_SENT` / `RST_RCVD`                           |
| QSL requested      | `QSL_SENT:R` (the other station requested a card) |
| QSL one way        | `QSL_SENT:N`, `QSL_RCVD:R` (their card is coming) |
| JCX                | `COMMENT` (`JCX 100101`), `APP_SPEECHTOQSO_JCX`   |
| Operator callsign  | `OPERATOR` (left out if empty)                    |
| Station callsign   | `STATION_CALLSIGN` (the operator's if not set)    |
| Operating location | `MY_CITY`                                         |
| Own JCC/JCG        | `APP_SPEECHTOQSO_MY_JCX`                          |
| POTA reference     | `MY_SIG=POTA`, `MY_SIG_INFO`, `MY_POTA_REF`       |

## Deployment

Build the app with the speech models, then the server, and run it with `WEB_DIR` pointing at the app:

```sh
cd web
npm ci
scripts/fetch-models.sh   # the small English and Japanese Vosk models → static/models
npm run build             # → web/build
cd ../server
cargo build --release     # → server/target/release/speech-to-qso-server
```

`fetch-models.sh` repacks each model (`vosk-model-small-en-us-0.15`, `vosk-model-small-ja-0.22`) as a `.tar.gz` with a
single top-level directory (the layout vosk-browser expects); they are served under `models/`. Settings → "Vosk
model" picks one; only the selected model is downloaded. vosk-browser stores it in IndexedDB on first load, so it keeps
working offline afterwards. To use a different model, set its `.tar.gz` URL under "Vosk model URL" in Settings and
pick its language above (the host must allow CORS).

## Development

```sh
cd web
npm install
npm run dev               # dev server; /api is forwarded to the server at API_SERVER (http://127.0.0.1:8080)
npm test                  # unit tests (vitest)
npm run test:e2e          # e2e tests of the app alone (Playwright / Chromium with a fake microphone)
npm run test:e2e:server   # e2e tests with the real server (passkeys through a virtual authenticator)
npm run check             # svelte-check (type checking)
npm run lint              # prettier

cd ../server
cargo test
cargo clippy --all-targets -- -D warnings
```

To sign in during development, run the server for the Vite origin (passkeys are bound to it) and open the link it
prints:

```sh
cd server
export PUBLIC_ORIGIN=http://localhost:5173
cargo run -- user create JJ1ABC
cargo run -- passkey bootstrap JJ1ABC
cargo run -- serve
```

To try Vosk locally, run `web/scripts/fetch-models.sh`.

### Layout

```
web/                      SvelteKit PWA
  src/lib/dsl/            Voice DSL: tokenizer, number words, parser, frequency resolver (pure logic)
  src/lib/qso/            Draft QSO, OperatingSession, QsoRecord, ADIF, band table
  src/lib/speech/         AudioWorklet, microphone capture, SpeechRecognizer (Vosk)
  src/lib/storage/        IndexedDB (QSO log, key-value store)
  src/lib/account/        Server API client, passkey (WebAuthn) helpers
  src/lib/sync/           QSO sync
  src/lib/app/            App state and the PTT → ASR → parser → draft pipeline
  src/lib/components/     Screens (QSO / Session / Log / Settings)
  src/service-worker/     Service worker for offline use
  e2e/                    Playwright tests of the app alone
  e2e-server/             Playwright tests with the real server
server/                   Rust + axum server: API, passkeys, SQLite (migrations/), Wavelog, admin CLI
```

## About the ASR

The ASR library sits behind the `SpeechRecognizer` interface (`web/src/lib/speech/recognizer.ts`), so switching from
Vosk to sherpa-onnx, Whisper or a server-side ASR only means implementing that interface.

- **Vosk grammar**: vosk-browser 0.0.8 accepts a grammar when creating a recognizer, so recognition is restricted to
  the DSL vocabulary. Vosk estimates a bigram language model from the phrases it is
  given, so the grammar is not a word list but every word-to-word transition the DSL allows, embedded in short
  utterances (`grammarPhrases()` in `web/src/lib/dsl/grammar.ts`): digits are expected after `received`, letters
  after `call sign`, and so on. Homophones and alternative spellings that only typed text produces
  (`to`, `for`, `alfa`, `juliett`, ...) are kept out of the grammar, since every extra short word is one more thing
  for noise to be decoded as. Spellings missing from the model's vocabulary are ignored by Vosk.
- **Japanese model**: Japanese speakers tend to say the DSL with Japanese sounds (`zero` as ゼロ), which the English
  model mishears. The Japanese model hears these as ordinary loanwords, so with it the commands are spoken as
  katakana (`ジュリエット リマ ワン`, `カード ワンウェイ`), letters can also be said as letter names (`Ｊ Ａ ワン Ｎ`),
  and the RST and frequency keywords are the plain Japanese words (`受信 ファイブ ナイン`, `送信 ファイブ セブン`,
  `周波数 ポイント ナイン フォー`). Every English word has one reading in `JAPANESE_READINGS`
  (`web/src/lib/dsl/lexicon.ts`), a single word of the model's vocabulary; words the model has no entry for, such as
  RTTY, are spelled with letter names. The tokenizer maps the readings back to the English DSL, so the parser does
  not change. CI checks the readings against the model's vocabulary.
- Vosk may finalize a segment at a pause in the middle of an utterance, so all results of one PTT press are joined
  into a single utterance.
- Recording continues for the `Release tail` (300 ms by default) after PTT is released, so the last word is not
  clipped.

## Possible next steps

- Evaluate ASR accuracy in real conditions (with rig audio playing). The QSO screen keeps a history of recognition
  results under "Recent utterances".
- Stronger vocabulary constraints (a vosk-browser fork, or hotword biasing with sherpa-onnx)
- Ship a local JCC/JCG list to show confirmations such as `JCX 100101 Minato, Tokyo`
