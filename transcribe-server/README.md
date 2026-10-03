# Transcription experiment

A standalone axum crate for comparing OpenAI `gpt-transcribe` and Google Cloud Speech-to-Text V2 with short QSO
recordings, plus Google V1 for ABNF grammar experiments. It sends completed audio files and returns the raw transcript and API round-trip time.
It does not interpret commands or log QSOs.

## Run

PowerShell, from this directory:

```powershell
Copy-Item config.example.toml config.toml
# Edit config.toml: set openai.api_key, google.project_id, or both.
cargo run
```

Open `http://127.0.0.1:8081` for the experiment UI. No frontend build or separate development server is needed.

`config.toml` is read from the current working directory and is ignored by Git. Its fields are:

```toml
listen = "127.0.0.1:8081"

[openai]
model = "gpt-transcribe"
api_key = "your-api-key"

[google]
project_id = "your-google-cloud-project-id"
location = "global"
model = "short"
v1_model = "latest_short"
```

Select another file with `cargo run -- --config path/to/experiment.toml`. An explicitly selected file must exist;
the default file can be omitted when using environment variables.
Nonempty `LISTEN`, `OPENAI_TRANSCRIBE_MODEL` and `OPENAI_API_KEY` environment variables override the corresponding
TOML fields (`listen`, `openai.model`, `openai.api_key`). Google overrides are `GOOGLE_CLOUD_PROJECT`, `GOOGLE_SPEECH_LOCATION`, `GOOGLE_SPEECH_MODEL` and
`GOOGLE_SPEECH_V1_MODEL`.
An empty Google project ID disables Google; an empty OpenAI key disables OpenAI. At least one must be configured.
`.env` is not loaded automatically. Credentials stay in the server process and are never returned to the UI.

This is a local experiment with no client authentication or CORS support. Keep it on loopback.

## Google V2 / ADC setup

Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), select a project with billing enabled,
and enable the Speech API. In PowerShell, replace `YOUR_PROJECT_ID`:

```powershell
gcloud services enable speech.googleapis.com --project YOUR_PROJECT_ID
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Add the `[google]` table shown above to your existing `config.toml`, then restart `cargo run`. Google-only use
does not need `openai.api_key`. The server uses the official `google-cloud-speech-v2` Rust SDK with default ADC
discovery and token refresh. It loads the client on the first Google request; startup and OpenAI use do not
require Google credentials. `gcloud auth login` alone does not configure local ADC.
`GOOGLE_APPLICATION_CREDENTIALS` is also supported through the SDK's ADC discovery, and points to a credential
configuration file; credentials are not copied into TOML or the browser.

The caller needs `roles/speech.client` (or equivalent recognition permissions) on the recognition project and
`roles/serviceusage.serviceUsageConsumer` on the ADC quota project. API enablement requires additional permissions.
See [ADC setup](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment) and
[Speech roles](https://docs.cloud.google.com/iam/docs/roles-permissions/speech).

Requests use the implicit recognizer `projects/PROJECT_ID/locations/LOCATION/recognizers/_`; no Recognizer or
PhraseSet resource is created. Audio is sent inline to synchronous `Recognize`, using automatic container decoding.
The default `global / short / en-US` supports phrase adaptation. For other models, change TOML and use a supported
location/language combination from the [supported language/model table](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages).
Regional locations automatically use `https://LOCATION-speech.googleapis.com` instead of the global endpoint.

Google accepts up to 10 MB and 60 seconds per synchronous clip. The server enforces the byte limit; Google validates
the duration and codec. PTT clips stop at 30 seconds. Use WAV, FLAC, MP3, OGG or WebM with a supported codec; an
OpenAI-compatible M4A file is not necessarily Google-compatible. Browser PTT WAV works with both providers.

Google keywords become an inline `SpeechAdaptation` PhraseSet. Boost can be set from 0 to 20; 0 leaves boost unset
for Google's default weighting. These are soft hints, not vocabulary constraints. An empty keyword list sends no
adaptation. Google accepts full BCP-47 language codes (default `en-US`), up to three; model/location support varies.
Google does not accept the OpenAI prompt field: the UI disables it and the server rejects a nonempty Google prompt.

## ABNF experiments (Google V1)

The public [V1 SpeechAdaptation API](https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v1/RecognitionConfig#SpeechAdaptation)
has `abnfGrammar.abnfStrings`; [V2 SpeechAdaptation](https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/projects.locations.recognizers#SpeechAdaptation)
has no ABNF field. Choose **Google V1 / ABNF** in the UI to test a complete SRGS ABNF grammar, or leave the grammar
blank for a baseline. V1 is enabled by the same `google.project_id` setting and uses the same ADC discovery.
Its optional `google.v1_model` defaults to `latest_short`; it does not reuse the V2 model name.

V1 uses REST `https://speech.googleapis.com/v1/speech:recognize` and the official `google-cloud-auth` Rust library
to cache/refresh ADC authentication headers. It uses the global endpoint independently of `google.location`, and
sets `x-goog-user-project` to `google.project_id` for quota/billing, so the caller needs Service Usage Consumer
permission on that project. It makes no persistent grammar or recognizer resources.

The V1 experiment accepts WAV or FLAC with format/sample-rate headers, at most 10 MB / 60 seconds, and one language
code (default `en-US`). PTT WAV works directly. The server passes the grammar as one `abnfStrings` entry without
parsing or rewriting it. Grammar size is limited locally to 64 KiB. For example, isolate the troublesome word:

```text
#ABNF 1.0 UTF-8;
language en-US;
mode voice;
root $command;
public $command = tango;
```

Set the UI language to match the grammar's language. SRGS ABNF uses `$rule = ...;` and `|` for alternatives;
it differs from RFC 5234 ABNF. See the [SRGS ABNF specification](https://www.w3.org/TR/speech-grammar/#S2).
This example tests an existing lexicon word; it does not define a second production QSO grammar.
The experiment does not expand the DSL lexicon into ABNF or post-process the transcript.

The service validates grammar syntax and model/language support. Do not assume grammar recognition is a guaranteed
closed vocabulary. Compare actual transcripts with/without ABNF and inspect `adaptation_info` in result details;
the UI warns if Google reports an adaptation timeout. Keywords and phrase boost can also be combined with ABNF.
Submitting ABNF to OpenAI or V2 is rejected instead of silently ignored.

In PowerShell, pass a saved grammar with curl's `<` form-file syntax:

```powershell
curl.exe http://127.0.0.1:8081/api/transcribe `
  -F 'provider=google-v1' `
  -F 'file=@utterance.wav' `
  -F 'abnf=<command.abnf' `
  -F 'languages[]=en-US'
```

## Browser experiment

- Enable the microphone, then hold the PTT button (or hold Space/Enter while it has focus). Release to transcribe.
- Only audio while held is collected; recordings stop after 30 seconds. Leaving the page cancels an active recording
  and closes the microphone. Enable it again when returning.
- Replay or download the captured WAV. Select a configured provider, change keywords, boost, prompt or language hints
  and use **Transcribe audio** to send the same recording again. Prompt is OpenAI-only; boost is Google-only.
- Alternatively select an audio file and click **Transcribe audio**. Microphone permission is not needed for uploads.
- The last 20 results show provider/model, exact transcripts, response times and the hints used. Google result details
  also include alternatives and confidence when returned by the API. History is kept only in
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
  -F 'provider=openai' `
  -F 'prompt=An English amateur radio logging command with phonetic letters and spoken digits.' `
  -F 'keywords[]=JCX' `
  -F 'keywords[]=QSL' `
  -F 'languages[]=en'
```

Compare Google V2 with the same WAV:

```powershell
curl.exe http://127.0.0.1:8081/api/transcribe `
  -F 'file=@utterance.wav' `
  -F 'provider=google' `
  -F 'keywords[]=tango' `
  -F 'keywords[]=JCX' `
  -F 'boost=10' `
  -F 'languages[]=en-US'
```

These are experimental hints, not a second DSL vocabulary or a constrained grammar. The canonical vocabulary stays
in `web/src/lib/dsl/lexicon.ts`. Leave the prompt and keywords out for a baseline, then compare exact transcripts,
especially callsigns, leading zeros and partial frequencies. The server injects no prompt or keywords; the UI starts
with a short radio prompt and the phonetic alphabet and digit words as keywords (Reset restores them), so clear
both fields for a baseline.

`POST /api/transcribe` accepts multipart fields:

| Field | Meaning |
| --- | --- |
| `file` | Exactly one nonempty file with a filename (OpenAI detects the format from its extension); OpenAI: 25 MB, Google: 10 MB / 60 seconds |
| `provider` | `openai`, `google` (V2), or `google-v1`; defaults to OpenAI if configured, otherwise V2 |
| `prompt` | Optional recording context, OpenAI only |
| `keywords[]` | Repeat for each literal hint; Google sends inline PhraseSet phrases |
| `boost` | Optional Google PhraseSet boost, 0–20; default 0 |
| `abnf` | Optional complete SRGS ABNF grammar, Google V1 only, up to 64 KiB |
| `languages[]` | Repeat for each expected language; defaults to OpenAI `en` / Google `en-US` |

Use a supported audio format such as WAV, WebM, MP3 or M4A. Raw PCM needs a WAV container before uploading.
The HTTP request has an additional 64 KiB allowance for multipart metadata and hints. The upstream timeout is 60 seconds.

Example response:

```json
{
  "text": "received five seven",
  "provider": "openai",
  "model": "gpt-transcribe",
  "elapsed_ms": 850,
  "request_id": null
}
```

`elapsed_ms` measures the upstream request and response decoding, excluding the incoming upload. The first Google
request also includes client initialization/ADC discovery. Transcripts are returned as received: punctuation and
number formatting are not rewritten. Google segments' top alternatives are joined with a newline, and full `results`
are included. `request_id` is null because neither SDK response exposes a request ID.
Provider failures return 502 with safe diagnostics (`upstream_status`, Google `upstream_code`);
timeouts return 504. Upstream error bodies are not exposed. Both providers have a 60-second total timeout, and SDK
automatic retries are disabled so a comparison makes one recognition attempt. No recordings or transcripts are persisted.
V1 also returns `adaptation_info` when the service supplies speech adaptation diagnostics.

The experiment UI is separate from the production QSO app. It does not apply recognized commands; command
interpretation stays in the existing parser.

API details: [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text),
[Google V2 Recognize](https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/projects.locations.recognizers/recognize),
[Google model adaptation](https://docs.cloud.google.com/speech-to-text/docs/adaptation-model).

## Checks

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Tests use local mock OpenAI and Google endpoints. Google SDK tests explicitly use anonymous mock credentials;
they do not load local ADC or make paid requests.
V1 tests use fake ADC headers and check exact audio/ABNF forwarding, replacement of the ADC quota-project header,
and input/error handling. They do not load local credentials.

For WAV encoding tests and browser tests (including a fake microphone), run from `web/`:

```sh
npm ci
npx playwright install chromium
npm run test:transcribe
```

The browser tests start this crate on port 8082 and intercept transcription requests without contacting providers.
To use an installed browser instead, set `PLAYWRIGHT_CHANNEL` (for example, `msedge`) before running the tests.
