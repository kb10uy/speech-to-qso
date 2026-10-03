# Transcription experiment

A standalone axum crate for trying `gpt-transcribe` with short QSO recordings. It sends completed audio files to
OpenAI and returns the raw transcript and API round-trip time. It does not interpret commands or log QSOs.

## Run

PowerShell, from this directory:

```powershell
Copy-Item config.example.toml config.toml
# Edit config.toml and set openai_api_key.
cargo run
```

Open `http://127.0.0.1:8081` for the experiment UI. No frontend build or separate development server is needed.

`config.toml` is read from the current working directory and is ignored by Git. Its fields are:

```toml
listen = "127.0.0.1:8081"
model = "gpt-transcribe"
openai_api_key = "your-api-key"
```

Select another file with `cargo run -- --config path/to/experiment.toml`. An explicitly selected file must exist;
the default file can be omitted when using environment variables.
Nonempty `LISTEN`, `OPENAI_TRANSCRIBE_MODEL` and `OPENAI_API_KEY` environment variables override the corresponding
TOML fields. `.env` is not loaded automatically. The API key stays in the server process and is never returned to the UI.

This is a local experiment with no client authentication or CORS support. Keep it on loopback.

## Browser experiment

- Enable the microphone, then hold the PTT button (or hold Space/Enter while it has focus). Release to transcribe.
- Only audio while held is collected; recordings stop after 30 seconds. Leaving the page cancels an active recording
  and closes the microphone. Enable it again when returning.
- Replay or download the captured WAV. Change the prompt, keywords or language hints and use **Transcribe audio**
  to send the same recording again.
- Alternatively select an audio file and click **Transcribe audio**. Microphone permission is not needed for uploads.
- The last 20 results show exact transcripts, upstream response times and the hints used. History is kept only in
  page memory and is cleared on reload.

The microphone requires localhost or HTTPS, and a browser supporting AudioWorklet and a 16 kHz AudioContext.
The browser converts device audio to 16 kHz; the worklet emits mono `Float32Array` only during PTT. The experimental
recognizer implements the existing `SpeechRecognizer` interface and sends a 16-bit WAV when the utterance ends.

## Try a recording

Use `curl.exe` in PowerShell to avoid the Windows PowerShell `curl` alias:

```powershell
curl.exe http://127.0.0.1:8081/api/health
curl.exe http://127.0.0.1:8081/api/transcribe -F 'file=@utterance.wav'
```

Compare the same recording with context and literal keyword hints:

```powershell
curl.exe http://127.0.0.1:8081/api/transcribe `
  -F 'file=@utterance.wav' `
  -F 'prompt=An English amateur radio logging command with phonetic letters and spoken digits.' `
  -F 'keywords[]=JCX' `
  -F 'keywords[]=QSL' `
  -F 'languages[]=en'
```

These are experimental hints, not a second DSL vocabulary or a constrained grammar. The canonical vocabulary stays
in `web/src/lib/dsl/lexicon.ts`. Leave the prompt and keywords out for a baseline, then compare exact transcripts,
especially callsigns, leading zeros and partial frequencies. No prompt or keywords are injected by default.

`POST /api/transcribe` accepts multipart fields:

| Field | Meaning |
| --- | --- |
| `file` | Exactly one nonempty audio file, at most 25 MB, with a filename and appropriate content type |
| `prompt` | Optional recording context |
| `keywords[]` | Repeat for each literal recognition hint |
| `languages[]` | Repeat for each expected input language; defaults to `en` if omitted |

Use a supported audio format such as WAV, WebM, MP3 or M4A. Raw PCM needs a WAV container before uploading.
The HTTP request has an additional 64 KiB allowance for multipart metadata and hints. The upstream timeout is 60 seconds.

Example response:

```json
{
  "text": "received five seven",
  "model": "gpt-transcribe",
  "elapsed_ms": 850,
  "request_id": "req_example"
}
```

`elapsed_ms` measures the upstream request and response decoding, excluding the incoming upload. Transcripts are
returned as received: punctuation and number formatting are not rewritten. OpenAI failures return 502 with
`upstream_status` and `request_id`; timeouts return 504. No recordings or transcripts are persisted by this crate.

The experiment UI is separate from the production QSO app. It does not apply recognized commands; command
interpretation stays in the existing parser.

API details: [official OpenAI file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text).

## Checks

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Tests use a local mock OpenAI endpoint and do not require an API key or make paid requests.

For WAV encoding tests and browser tests (including a fake microphone), run from `web/`:

```sh
npm ci
npx playwright install chromium
npm run test:transcribe
```

The browser tests start this crate on port 8082 and intercept transcription requests without contacting OpenAI.
To use an installed browser instead, set `PLAYWRIGHT_CHANNEL` (for example, `msedge`) before running the tests.
