# speech-to-qso

移動運用向けの **PTT 式 QSO 音声入力** Web アプリです。スマホで PTT ボタンを押しながら
「juliett lima one hotel india sierra」「received five seven」のように話すと、Draft QSO の該当フィールドが埋まり、
**LOG QSO** でローカル (IndexedDB) に保存 → バックエンド経由で Wavelog に同期します。

自然言語理解はしません。既存 ASR を **lexer** として使い、語彙と構文を絞った **QSO 専用 DSL** を自前の parser で解釈します。

- Web クライアント: SvelteKit + TypeScript の PWA (GitHub Pages で配信、オフライン動作)
- 音声認識: [Vosk](https://alphacephei.com/vosk/) WASM ([vosk-browser](https://github.com/ccoreilly/vosk-browser)) をブラウザ内で実行。Web Speech API も選択可
- バックエンド: Rust + axum の薄い API。QSO をローカルログに追記し Wavelog に転送

```
PTT 長押し → getUserMedia → AudioWorklet (16 kHz mono) → Vosk WASM (Worker)
  → テキスト → DSL parser → Draft QSO 更新 → 画面で確認 → LOG QSO
  → IndexedDB に保存 → (オンラインなら) POST /api/qso → Wavelog
```

## 使い方

1. https://kb10uy.github.io/speech-to-qso/ を開く (ホーム画面に追加すると PWA としてインストールできます)
2. **Session** タブで OP コール、移動地、周波数 anchor などを保存
3. **QSO** タブで「Load speech engine」を押して音声モデル (約 40 MB、初回のみ) を読み込む
4. **HOLD TO TALK** を押している間だけ話す。離すと認識 → parse → Draft に反映
5. 内容を確認して **LOG QSO**

認識結果と反映内容はボタン上のフィードバック欄に出ます (`“received five seven” → RST received → 57`)。
ASR が失敗するときは「Type a command」から同じ DSL をキーボード入力できます (`jl1his`, `received 57`, `freq .94` のような短縮形も可)。
PC では Space キーが PTT になります。

### 音声コマンド (DSL)

| 発話例                                              | 結果                                    |
| --------------------------------------------------- | --------------------------------------- |
| `juliett lima one hotel india sierra`               | Callsign = `JL1HIS`                     |
| `... stroke one` / `... portable`                   | `JL1HIS/1` / `JL1HIS/P`                 |
| `sent five nine` (`send` も可)                      | RST sent = `59`                         |
| `received five seven` (`receive` も可)              | RST received = `57`                     |
| `frequency point nine four`                         | 周波数 `*.940` MHz → anchor 最寄り      |
| `frequency two point seven four`                    | `*2.740` MHz                            |
| `frequency four thirty two point nine four`         | `432.940` MHz                           |
| `jcx one zero zero one zero one` (`jcc`/`jcg` も可) | JCX = `"100101"` (文字列。先頭ゼロ保持) |
| `card requested` / `no card`                        | QSL requested on / off                  |
| `mode foxtrot mike` / `mode fm`                     | Mode = `FM`                             |

- **修正コマンドはありません。** 同じフィールドをもう一度話すと、そのフィールド全体を上書きします。
- 1 回の PTT で複数コマンドを続けて言えます (`juliett lima one hotel india sierra received five seven`)。
  一部でも parse に失敗した発話は **丸ごと破棄** します (中途半端な反映はしません)。
- 先頭がキーワードでない発話はコールサインとして扱います (`call` / `callsign` を前置しても可)。
- 数字は `four thirty two` → `432`, `one forty five` → `145`, `double five` → `55` のように無線式の読み方を解釈します。
- RST のデフォルトは `59 / 59`。周波数とモードは次の QSO に引き継ぎます。

### 周波数 resolver

**発話された桁だけを制約とし、省略された上位桁を wildcard として、frequency anchor に最も近い候補を採用**します。

```
anchor = 433.000 MHz
"frequency point nine four"      → *.940  → 432.940 (433.940 より近い)
"frequency two point seven four" → *2.740 → 432.740
```

anchor (Session で設定) と現在周波数は別物です。リグが 430.200 MHz にいても anchor が 433.000 なら
`point nine four` は 432.940 になります。実装は `web/src/lib/dsl/frequency.ts` の純粋関数です。

## 同期とバックエンド

LOG QSO は **必ず先に IndexedDB に保存** し、同期は別ステップです。ネットワーク失敗が QSO 記録失敗になることはありません。
Log タブで各 QSO の状態 (`local` / `waiting` / `synced` / `failed`) を確認でき、オンライン復帰時・起動時に自動で再送します。
バックエンドなしでも、Log タブの **Export ADIF** で `.adi` を書き出せます。

バックエンド (`server/`) は Wavelog の API キーをブラウザに置かないための薄い API です。

```sh
cd server
cp .env.example .env   # 編集して環境変数に設定
cargo run --release
```

| 環境変数             | 説明                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `LISTEN`             | listen アドレス (既定 `127.0.0.1:8080`)                                      |
| `API_TOKEN`          | クライアントが送る Bearer token (Settings → API token)。未設定だと認証なし   |
| `ALLOWED_ORIGINS`    | CORS 許可 origin (カンマ区切り)。例 `https://kb10uy.github.io`。空なら全許可 |
| `DATA_DIR`           | `qsos.jsonl` (イベントログ) と `log.adi` (ADIF) の保存先 (既定 `data`)       |
| `WAVELOG_URL`        | Wavelog のベース URL (例 `https://log.example.com`)                          |
| `WAVELOG_API_KEY`    | Wavelog の API キー (read/write)                                             |
| `WAVELOG_STATION_ID` | 既定の station location id (Session で QSO ごとに上書き可)                   |

- GitHub Pages は HTTPS なので、**バックエンドも HTTPS で公開** してください (Caddy / nginx などのリバースプロキシ推奨)。
- `POST /api/qso` はクライアント生成の UUID で重複排除するので、再送しても二重登録されません。
  Wavelog への転送に失敗した場合は 502 を返し、クライアントの再送時に転送だけ再試行します。
- `GET /api/health` で疎通確認できます。

### ADIF へのマッピング

| QSO フィールド  | ADIF                                            |
| --------------- | ----------------------------------------------- |
| callsign        | `CALL`                                          |
| 周波数          | `FREQ` (MHz), `BAND`                            |
| RST sent / rcvd | `RST_SENT` / `RST_RCVD`                         |
| QSL requested   | `QSL_SENT:R` (相手局からカード請求あり)         |
| JCX             | `COMMENT` (`JCX 100101`), `APP_SPEECHTOQSO_JCX` |
| OP コール       | `OPERATOR`, `STATION_CALLSIGN`                  |
| 移動地          | `MY_CITY`                                       |
| 自局 JCC/JCG    | `APP_SPEECHTOQSO_MY_JCX`                        |
| POTA reference  | `MY_SIG=POTA`, `MY_SIG_INFO`, `MY_POTA_REF`     |

## デプロイ (GitHub Pages)

`main` に push すると `.github/workflows/pages.yml` がビルドしてデプロイします (手動実行も可)。
初回のみリポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にしてください。

ビルド時に Vosk の小型英語モデル (`vosk-model-small-en-us-0.15`) を取得し、vosk-browser 用に
`.tar.gz` (トップレベルにディレクトリ 1 つ) へ詰め替えて `models/` に同梱します。
モデルは初回読み込み時に vosk-browser が IndexedDB に保存するので、以降はオフラインでも使えます。
別のモデルを使う場合は Settings の「Vosk model URL」に `.tar.gz` の URL を指定します (CORS 許可が必要)。

## 開発

```sh
cd web
npm install
npm run dev          # 開発サーバ (マイクは localhost なら HTTP でも可)
npm test             # unit tests (vitest)
npm run test:e2e     # e2e tests (Playwright / Chromium、偽マイク入力)
npm run check        # svelte-check (型検査)
npm run lint         # prettier

cd ../server
cargo test
cargo clippy --all-targets -- -D warnings
```

ローカルで Vosk を試すには、モデルを `web/static/models/vosk-model-small-en-us-0.15.tar.gz` に置いてください
(`pages.yml` の「Fetch Vosk model」と同じ手順)。

### ディレクトリ構成

```
web/                      SvelteKit PWA
  src/lib/dsl/            音声 DSL: tokenizer, 数字読み, parser, 周波数 resolver (純粋ロジック)
  src/lib/qso/            Draft QSO, OperatingSession, QsoRecord, ADIF, バンド表
  src/lib/speech/         AudioWorklet, マイク入力, SpeechRecognizer (Vosk / Web Speech API)
  src/lib/storage/        IndexedDB (QSO ログ, KV)
  src/lib/sync/           バックエンド同期クライアント
  src/lib/app/            アプリ状態と PTT → ASR → parser → draft のパイプライン
  src/lib/components/     画面 (QSO / Session / Log / Settings)
  src/service-worker/     オフライン用 Service Worker
  e2e/                    Playwright テスト
server/                   Rust + axum バックエンド
```

## ASR について

ASR ライブラリは `SpeechRecognizer` interface (`web/src/lib/speech/recognizer.ts`) の裏に隠してあるので、
Vosk → sherpa-onnx / Whisper / サーバーサイド ASR などへの差し替えはこの interface を実装するだけです。

- **Vosk grammar**: vosk-browser 0.0.8 は recognizer 生成時の grammar 指定を受け付けるので、
  DSL の語彙 (`grammarVocabulary()` in `web/src/lib/dsl/lexicon.ts`) で認識を制約しています (Settings で無効化可)。
  モデル語彙にない綴り (例: `juliett`) は Vosk 側で無視され、同じ文字の別綴り (`juliet`) が使われます。
- Vosk は発話中のポーズで区切りを確定することがあるので、PTT 1 回分の途中結果はすべて連結して 1 発話として扱います。
- PTT を離した後も `Release tail` (既定 300 ms) だけ録音を続け、語尾の欠けを防ぎます。

## 今後の候補

- 実環境 (無線機の音が鳴っている状況) での ASR 精度評価。QSO 画面の「Recent utterances」に認識結果の履歴が残ります
- 語彙制約の強化 (vosk-browser fork / sherpa-onnx の hotword biasing)
- JCC/JCG 一覧をローカルに持ち、`JCX 100101 東京都 ○○区` のような確認表示
