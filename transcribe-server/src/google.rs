//! Google V2 synchronous file recognition, using SDK-managed ADC credentials.

use std::time::{Duration, Instant};

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use google_cloud_gax::{options::RequestOptionsBuilder, retry_policy::NeverRetry};
use google_cloud_speech_v2::{
    client::Speech,
    model::{
        AutoDetectDecodingConfig, PhraseSet, RecognitionConfig, SpeechAdaptation, phrase_set::Phrase,
        speech_adaptation::AdaptationPhraseSet,
    },
};
use serde_json::json;
use tokio::sync::OnceCell;

use crate::{ApiError, Upload, config::GoogleConfig};

pub(crate) struct GoogleState {
    pub config: GoogleConfig,
    pub client: OnceCell<Speech>,
}

impl GoogleState {
    pub fn new(config: GoogleConfig) -> Self {
        Self {
            config,
            client: OnceCell::new(),
        }
    }

    pub async fn transcribe(&self, upload: Upload) -> Result<Response, ApiError> {
        if upload.abnf.is_some() {
            return Err(ApiError::bad_request(
                "ABNF is not supported by Google V2; select Google V1 / ABNF",
            ));
        }
        if upload.bytes.len() > 10_000_000 {
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Google synchronous audio is limited to 10 MB and 60 seconds".into(),
            ));
        }
        if upload.prompt.as_ref().is_some_and(|prompt| !prompt.trim().is_empty()) {
            return Err(ApiError::bad_request(
                "Google does not accept a prompt; use keywords and boost",
            ));
        }
        if upload.languages.len() > 3 {
            return Err(ApiError::bad_request("Google accepts at most three language codes"));
        }
        if upload.keywords.len() > 5000
            || upload.keywords.iter().any(|phrase| phrase.chars().count() > 100)
            || upload
                .keywords
                .iter()
                .map(|phrase| phrase.chars().count())
                .sum::<usize>()
                > 100_000
        {
            return Err(ApiError::bad_request(
                "Google keywords are limited to 5000 phrases, 100 characters per phrase and 100000 total characters",
            ));
        }
        let languages = if upload.languages.is_empty() {
            vec!["en-US".into()]
        } else {
            upload.languages
        };
        let mut config = RecognitionConfig::new()
            .set_model(&self.config.model)
            .set_language_codes(languages)
            .set_auto_decoding_config(AutoDetectDecodingConfig::new());
        if !upload.keywords.is_empty() {
            let phrases = upload.keywords.into_iter().map(|value| Phrase::new().set_value(value));
            let phrase_set = PhraseSet::new()
                .set_phrases(phrases)
                .set_boost(upload.boost.unwrap_or(0.0));
            config = config.set_adaptation(
                SpeechAdaptation::new().set_phrase_sets([AdaptationPhraseSet::new().set_inline_phrase_set(phrase_set)]),
            );
        }
        let started = Instant::now();
        // Bound credential loading and the complete call, and avoid automatic paid retries in comparisons.
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            let client = self.client.get_or_try_init(|| async {
                Speech::builder().with_endpoint(self.config.endpoint()).build().await
                    .map_err(|_| ApiError(StatusCode::BAD_GATEWAY,
                        "Google ADC initialization failed; run gcloud auth application-default login or configure GOOGLE_APPLICATION_CREDENTIALS".into()))
            }).await?;
            Ok::<_, ApiError>(client.recognize()
                .set_recognizer(self.config.recognizer())
                .set_config(config)
                .set_content(upload.bytes)
                .with_retry_policy(NeverRetry)
                .with_attempt_timeout(Duration::from_secs(60))
                .send().await)
        }).await.map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "Google transcription timed out".into()))??;
        match result {
            Ok(response) => {
                // Each segment's top alternative is returned verbatim; keep the full results for inspection.
                let text = response
                    .results
                    .iter()
                    .filter_map(|result| result.alternatives.first())
                    .map(|alternative| alternative.transcript.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Json(json!({
                    "text": text, "provider": "google", "model": self.config.model,
                    "elapsed_ms": started.elapsed().as_millis(), "request_id": null,
                    "results": response.results
                }))
                .into_response())
            }
            Err(error) => {
                let upstream_status = error.http_status_code();
                let upstream_code = error.status().map(|status| format!("{:?}", status.code));
                tracing::warn!(?upstream_status, ?upstream_code, "Google rejected transcription");
                // SDK errors can include credential paths, audio or provider bodies; expose only safe diagnostics.
                let message = if error.is_authentication() {
                    "Google ADC authentication failed; refresh ADC with gcloud auth application-default login"
                } else if upstream_status == Some(403) {
                    "Google denied access; check Speech API enablement, billing, speech.client and quota-project permissions"
                } else if upstream_status == Some(400) {
                    "Google rejected the audio or settings; check the 60-second limit, format, language codes and model/location support"
                } else {
                    "Google transcription request failed"
                };
                Ok((if error.is_timeout() { StatusCode::GATEWAY_TIMEOUT } else { StatusCode::BAD_GATEWAY },
                    Json(json!({ "error": message, "upstream_status": upstream_status, "upstream_code": upstream_code, "request_id": null }))
                ).into_response())
            }
        }
    }
}
