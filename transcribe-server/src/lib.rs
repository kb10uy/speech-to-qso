//! Standalone file-transcription experiment. Interpretation stays in the QSO DSL parser.

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, State, multipart::MultipartError},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::json;

const MAX_AUDIO_BYTES: usize = 25_000_000;
// Leave room for multipart headers and transcription hints above the file limit.
const MAX_BODY_BYTES: usize = MAX_AUDIO_BYTES + 64 * 1024;

pub mod config;

pub struct AppState {
    client: reqwest::Client,
    api_key: String,
    model: String,
    endpoint: String,
}

impl AppState {
    pub fn new(api_key: String, model: String) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            api_key,
            model,
            endpoint: "https://api.openai.com/v1/audio/transcriptions".into(),
        })
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(|| async { Html(include_str!("../frontend/index.html")) }))
        .route(
            "/style.css",
            get(|| async { asset("text/css", include_str!("../frontend/style.css")) }),
        )
        .route(
            "/app.js",
            get(|| async { asset("text/javascript", include_str!("../frontend/app.js")) }),
        )
        .route(
            "/recognizer.js",
            get(|| async { asset("text/javascript", include_str!("../frontend/recognizer.js")) }),
        )
        .route(
            "/pcm-worklet.js",
            get(|| async { asset("text/javascript", include_str!("../frontend/pcm-worklet.js")) }),
        )
        .route("/api/health", get(health))
        .route("/api/transcribe", post(transcribe))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

fn asset(content_type: &'static str, source: &'static str) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        source,
    )
}

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "model": state.model }))
}

struct ApiError(StatusCode, String);

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
}

impl From<MultipartError> for ApiError {
    fn from(error: MultipartError) -> Self {
        Self(error.status(), error.body_text())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

async fn upload_form(mut multipart: Multipart, model: &str) -> Result<Form, ApiError> {
    let mut form = Form::new()
        .text("model", model.to_owned())
        .text("response_format", "json");
    let mut has_file = false;
    let mut has_prompt = false;
    let mut has_languages = false;

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "file" => {
                if has_file {
                    return Err(ApiError::bad_request("send exactly one file"));
                }
                let filename = field
                    .file_name()
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| ApiError::bad_request("file must have a filename"))?
                    .to_owned();
                let content_type = field.content_type().unwrap_or("application/octet-stream").to_owned();
                let bytes = field.bytes().await?;
                if bytes.is_empty() {
                    return Err(ApiError::bad_request("file is empty"));
                }
                if bytes.len() > MAX_AUDIO_BYTES {
                    return Err(ApiError(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "audio file exceeds 25 MB".into(),
                    ));
                }
                let part = Part::bytes(bytes.to_vec())
                    .file_name(filename)
                    .mime_str(&content_type)
                    .map_err(|_| ApiError::bad_request("invalid file content type"))?;
                form = form.part("file", part);
                has_file = true;
            }
            "prompt" => {
                if has_prompt {
                    return Err(ApiError::bad_request("send at most one prompt"));
                }
                form = form.text("prompt", field.text().await?);
                has_prompt = true;
            }
            "keywords[]" | "languages[]" => {
                let value = field.text().await?;
                if value.trim().is_empty() {
                    return Err(ApiError::bad_request(format!("{name} must not be empty")));
                }
                if name == "keywords[]" && value.contains(['<', '>', '\r', '\n']) {
                    return Err(ApiError::bad_request("keywords must not contain <, > or line breaks"));
                }
                has_languages |= name == "languages[]";
                form = form.text(name, value);
            }
            _ => return Err(ApiError::bad_request(format!("unsupported field: {name}"))),
        }
    }
    if !has_file {
        return Err(ApiError::bad_request("file is required"));
    }
    if !has_languages {
        form = form.text("languages[]", "en");
    }
    Ok(form)
}

#[derive(Deserialize)]
struct Transcript {
    text: String,
}

async fn transcribe(State(state): State<Arc<AppState>>, multipart: Multipart) -> Result<Response, ApiError> {
    let form = upload_form(multipart, &state.model).await?;
    let started = std::time::Instant::now();
    let response = state
        .client
        .post(&state.endpoint)
        .bearer_auth(&state.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("transcription request failed: {error}");
            ApiError(
                if error.is_timeout() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                },
                "OpenAI transcription request failed".into(),
            )
        })?;
    let status = response.status();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if !status.is_success() {
        tracing::warn!(%status, ?request_id, "OpenAI rejected transcription");
        // Do not reflect provider error bodies, which can contain credentials or uploaded text.
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "OpenAI rejected transcription",
                "upstream_status": status.as_u16(),
                "request_id": request_id
            })),
        )
            .into_response());
    }
    let transcript: Transcript = response.json().await.map_err(|error| {
        tracing::warn!("invalid transcription response: {error}");
        if error.is_timeout() {
            ApiError(
                StatusCode::GATEWAY_TIMEOUT,
                "OpenAI transcription response timed out".into(),
            )
        } else {
            ApiError(StatusCode::BAD_GATEWAY, "invalid OpenAI transcription response".into())
        }
    })?;
    Ok(Json(json!({
        "text": transcript.text,
        "model": state.model,
        "elapsed_ms": started.elapsed().as_millis(),
        "request_id": request_id
    }))
    .into_response())
}

#[cfg(test)]
mod tests;
