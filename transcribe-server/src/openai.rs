//! OpenAI file transcription through the `async-openai` client.

use std::time::Instant;

use async_openai::{
    Client,
    config::OpenAIConfig,
    error::OpenAIError,
    middleware::ReqwestService,
    types::{
        InputSource,
        audio::{AudioInput, AudioResponseFormat, CreateTranscriptionRequest},
    },
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;

use crate::{ApiError, Upload};

pub(crate) const API_BASE: &str = "https://api.openai.com/v1";

pub(crate) struct OpenaiState {
    model: String,
    client: Client<OpenAIConfig>,
}

#[derive(Deserialize)]
struct Transcript {
    text: String,
}

impl OpenaiState {
    pub fn new(client: &reqwest::Client, api_key: &str, model: String, api_base: &str) -> Self {
        // The plain service replaces the default retry layer: a comparison makes one recognition attempt.
        let client = Client::build(
            client.clone(),
            OpenAIConfig::new().with_api_key(api_key).with_api_base(api_base),
        )
        .with_http_service(ReqwestService::new(client.clone()));
        Self { model, client }
    }

    pub async fn transcribe(&self, upload: Upload) -> Result<Response, ApiError> {
        let request = self.request(upload)?;
        let started = Instant::now();
        // The typed response requires fields that the experiment does not use; only the text matters here.
        let result: Result<Transcript, _> = self.client.audio().transcription().create_byot(request).await;
        let transcript = match result {
            Ok(transcript) => transcript,
            Err(OpenAIError::ApiError(response)) => {
                let status = response.status_code;
                tracing::warn!(%status, "OpenAI rejected transcription");
                // Do not reflect provider error bodies, which can contain credentials or uploaded text.
                return Ok((
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": "OpenAI rejected transcription",
                        "upstream_status": status.as_u16(),
                        "request_id": null
                    })),
                )
                    .into_response());
            }
            Err(OpenAIError::JSONDeserialize(error, _)) => {
                tracing::warn!("invalid transcription response: {error}");
                return Err(ApiError(
                    StatusCode::BAD_GATEWAY,
                    "invalid OpenAI transcription response".into(),
                ));
            }
            Err(error) => {
                let timed_out = matches!(&error, OpenAIError::Reqwest(error) if error.is_timeout());
                tracing::warn!("transcription request failed: {error}");
                return Err(ApiError(
                    if timed_out {
                        StatusCode::GATEWAY_TIMEOUT
                    } else {
                        StatusCode::BAD_GATEWAY
                    },
                    "OpenAI transcription request failed".into(),
                ));
            }
        };
        Ok(Json(json!({
            "text": transcript.text,
            "provider": "openai",
            "model": self.model,
            "elapsed_ms": started.elapsed().as_millis(),
            "request_id": null
        }))
        .into_response())
    }

    fn request(&self, upload: Upload) -> Result<CreateTranscriptionRequest, ApiError> {
        if upload.abnf.is_some() {
            return Err(ApiError::bad_request("ABNF is only supported by Google V1"));
        }
        if upload.boost.is_some() {
            return Err(ApiError::bad_request("boost is only supported by Google"));
        }
        let languages = if upload.languages.is_empty() {
            vec!["en".into()]
        } else {
            upload.languages
        };
        Ok(CreateTranscriptionRequest {
            file: AudioInput {
                source: InputSource::VecU8 {
                    filename: upload.filename,
                    vec: upload.bytes,
                },
            },
            model: self.model.clone(),
            prompt: upload.prompt,
            response_format: Some(AudioResponseFormat::Json),
            languages: Some(languages),
            keywords: (!upload.keywords.is_empty()).then_some(upload.keywords),
            ..Default::default()
        })
    }
}
