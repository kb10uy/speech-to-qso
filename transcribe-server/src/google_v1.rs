//! V1 ABNF experiments use REST because the official Speech Rust SDK targets V2.

use std::time::{Duration, Instant};

use axum::{
    Json,
    http::{Extensions, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use google_cloud_auth::credentials::{CacheableResource, Credentials};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::OnceCell;

use crate::{ApiError, Upload, config::GoogleConfig};

pub(crate) struct GoogleV1State {
    config: GoogleConfig,
    pub credentials: OnceCell<Credentials>,
    pub endpoint: String,
}

impl GoogleV1State {
    pub fn new(config: GoogleConfig) -> Self {
        Self {
            config,
            credentials: OnceCell::new(),
            endpoint: "https://speech.googleapis.com/v1/speech:recognize".into(),
        }
    }

    pub async fn transcribe(&self, client: &reqwest::Client, upload: Upload) -> Result<Response, ApiError> {
        if upload.bytes.len() > 10_000_000 {
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Google synchronous audio is limited to 10 MB and 60 seconds".into(),
            ));
        }
        // WAV and FLAC headers let V1 detect sample rate and encoding without guessing from the filename.
        let wav = upload.bytes.starts_with(b"RIFF") && upload.bytes.get(8..12) == Some(b"WAVE");
        if !wav && !upload.bytes.starts_with(b"fLaC") {
            return Err(ApiError::bad_request(
                "Google V1 experiment accepts WAV or FLAC; use PTT WAV or convert the recording",
            ));
        }
        if upload.prompt.as_ref().is_some_and(|prompt| !prompt.trim().is_empty()) {
            return Err(ApiError::bad_request(
                "Google does not accept a prompt; use ABNF or keywords",
            ));
        }
        if upload.languages.len() > 1 {
            return Err(ApiError::bad_request(
                "Google V1 ABNF experiment accepts exactly one language code",
            ));
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
            return Err(ApiError::bad_request("Google keywords exceed PhraseSet limits"));
        }
        let language = upload.languages.first().map(String::as_str).unwrap_or("en-US");
        let mut config = json!({ "model": self.config.v1_model, "languageCode": language });
        let mut adaptation = serde_json::Map::new();
        if let Some(grammar) = upload.abnf {
            // Keep the complete SRGS grammar verbatim, including declarations and line breaks.
            adaptation.insert("abnfGrammar".into(), json!({ "abnfStrings": [grammar] }));
        }
        if !upload.keywords.is_empty() {
            let phrases: Vec<_> = upload
                .keywords
                .into_iter()
                .map(|value| json!({ "value": value }))
                .collect();
            let mut phrase_set = json!({ "phrases": phrases });
            if let Some(boost) = upload.boost.filter(|boost| *boost > 0.0) {
                phrase_set["boost"] = json!(boost);
            }
            adaptation.insert("phraseSets".into(), json!([phrase_set]));
        }
        if !adaptation.is_empty() {
            config["adaptation"] = adaptation.into();
        }
        let body = json!({ "config": config, "audio": { "content": STANDARD.encode(upload.bytes) } });
        let started = Instant::now();
        tokio::time::timeout(Duration::from_secs(60), async {
            let credentials = self.credentials.get_or_try_init(|| async {
                google_cloud_auth::credentials::Builder::default()
                    .with_scopes(["https://www.googleapis.com/auth/cloud-platform"])
                    .build().map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "Google ADC initialization failed; run gcloud auth application-default login".into()))
            }).await?;
            let CacheableResource::New { data: mut headers, .. } = credentials.headers(Extensions::new()).await
                .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "Google ADC authentication failed; refresh application-default login".into()))?
            else { return Err(ApiError(StatusCode::BAD_GATEWAY, "Google ADC did not return authentication headers".into())); };
            // V1 has no project in the URL, so select the configured project explicitly for quota/billing.
            // Replace any ADC quota header; appending would send two project values to Google.
            headers.insert("x-goog-user-project", self.config.project_id.parse()
                .map_err(|_| ApiError::bad_request("invalid Google project ID"))?);
            let response = client.post(&self.endpoint).headers(headers)
                .json(&body).send().await
                .map_err(request_error)?;
            let status = response.status();
            if !status.is_success() {
                let message = match status.as_u16() {
                    400 => "Google V1 rejected the grammar or audio settings; check SRGS ABNF syntax, model/language support and the 60-second limit",
                    401 => "Google V1 authentication failed; refresh application-default login",
                    403 => "Google V1 denied access; check Speech API enablement, billing and project permissions",
                    _ => "Google V1 transcription request failed",
                };
                tracing::warn!(%status, "Google V1 rejected transcription");
                return Ok((StatusCode::BAD_GATEWAY, Json(json!({ "error": message, "upstream_status": status.as_u16(), "request_id": null }))).into_response());
            }
            let response: V1Response = response.json().await.map_err(|error| {
                if error.is_timeout() { request_error(error) }
                else { ApiError(StatusCode::BAD_GATEWAY, "invalid Google V1 transcription response".into()) }
            })?;
            let text = response.results.iter().filter_map(|result| result.alternatives.first())
                .map(|alternative| alternative.transcript.as_str()).collect::<Vec<_>>().join("\n");
            Ok(Json(json!({ "text": text, "provider": "google-v1", "model": self.config.v1_model,
                "elapsed_ms": started.elapsed().as_millis(), "request_id": null, "results": response.results,
                "adaptation_info": response.speech_adaptation_info })).into_response())
        }).await.map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "Google V1 transcription timed out".into()))?
    }
}

fn request_error(error: reqwest::Error) -> ApiError {
    ApiError(
        if error.is_timeout() {
            StatusCode::GATEWAY_TIMEOUT
        } else {
            StatusCode::BAD_GATEWAY
        },
        "Google V1 transcription request failed".into(),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V1Response {
    #[serde(default)]
    results: Vec<V1Result>,
    speech_adaptation_info: Option<serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
struct V1Result {
    #[serde(default)]
    alternatives: Vec<V1Alternative>,
    #[serde(flatten)]
    details: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
struct V1Alternative {
    transcript: String,
    #[serde(flatten)]
    details: serde_json::Map<String, serde_json::Value>,
}
