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
mod google;

pub struct AppState {
    client: reqwest::Client,
    api_key: String,
    model: String,
    endpoint: String,
    google: Option<google::GoogleState>,
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
            google: None,
        })
    }

    pub fn with_google(mut self, config: Option<config::GoogleConfig>) -> Self {
        self.google = config.map(google::GoogleState::new);
        self
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
    let mut providers = Vec::new();
    if !state.api_key.is_empty() {
        providers.push(json!({ "id": "openai", "label": "OpenAI", "model": state.model }));
    }
    if let Some(google) = &state.google {
        providers.push(json!({ "id": "google", "label": "Google Cloud STT V2", "model": google.config.model }));
    }
    Json(json!({ "status": "ok", "model": state.model, "providers": providers }))
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

struct Upload {
    bytes: Vec<u8>,
    filename: String,
    content_type: String,
    provider: Option<String>,
    prompt: Option<String>,
    keywords: Vec<String>,
    languages: Vec<String>,
    boost: Option<f32>,
}

async fn read_upload(mut multipart: Multipart) -> Result<Upload, ApiError> {
    let mut file = None;
    let mut prompt = None;
    let mut provider = None;
    let mut boost = None;
    let mut keywords = Vec::new();
    let mut languages = Vec::new();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "file" => {
                if file.is_some() {
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
                file = Some((bytes.to_vec(), filename, content_type));
            }
            "prompt" => {
                if prompt.is_some() {
                    return Err(ApiError::bad_request("send at most one prompt"));
                }
                prompt = Some(field.text().await?);
            }
            "provider" => {
                if provider.is_some() {
                    return Err(ApiError::bad_request("send at most one provider"));
                }
                let value = field.text().await?;
                if !matches!(value.as_str(), "openai" | "google") {
                    return Err(ApiError::bad_request("provider must be openai or google"));
                }
                provider = Some(value);
            }
            "boost" => {
                if boost.is_some() {
                    return Err(ApiError::bad_request("send at most one boost"));
                }
                let value: f32 = field
                    .text()
                    .await?
                    .parse()
                    .map_err(|_| ApiError::bad_request("boost must be a number from 0 to 20"))?;
                if !value.is_finite() || !(0.0..=20.0).contains(&value) {
                    return Err(ApiError::bad_request("boost must be a number from 0 to 20"));
                }
                boost = Some(value);
            }
            "keywords[]" | "languages[]" => {
                let value = field.text().await?;
                if value.trim().is_empty() {
                    return Err(ApiError::bad_request(format!("{name} must not be empty")));
                }
                if name == "keywords[]" && value.contains(['<', '>', '\r', '\n']) {
                    return Err(ApiError::bad_request("keywords must not contain <, > or line breaks"));
                }
                if name == "keywords[]" {
                    keywords.push(value);
                } else {
                    languages.push(value);
                }
            }
            _ => return Err(ApiError::bad_request(format!("unsupported field: {name}"))),
        }
    }
    let (bytes, filename, content_type) = file.ok_or_else(|| ApiError::bad_request("file is required"))?;
    Ok(Upload {
        bytes,
        filename,
        content_type,
        provider,
        prompt,
        keywords,
        languages,
        boost,
    })
}

fn openai_form(upload: Upload, model: &str) -> Result<Form, ApiError> {
    if upload.boost.is_some() {
        return Err(ApiError::bad_request("boost is only supported by Google"));
    }
    let part = Part::bytes(upload.bytes)
        .file_name(upload.filename)
        .mime_str(&upload.content_type)
        .map_err(|_| ApiError::bad_request("invalid file content type"))?;
    let mut form = Form::new()
        .text("model", model.to_owned())
        .text("response_format", "json")
        .part("file", part);
    if let Some(prompt) = upload.prompt {
        form = form.text("prompt", prompt);
    }
    for keyword in upload.keywords {
        form = form.text("keywords[]", keyword);
    }
    let languages = if upload.languages.is_empty() {
        vec!["en".into()]
    } else {
        upload.languages
    };
    for language in languages {
        form = form.text("languages[]", language);
    }
    Ok(form)
}

#[derive(Deserialize)]
struct Transcript {
    text: String,
}

async fn transcribe(State(state): State<Arc<AppState>>, multipart: Multipart) -> Result<Response, ApiError> {
    let upload = read_upload(multipart).await?;
    let provider = upload
        .provider
        .as_deref()
        .unwrap_or(if state.api_key.is_empty() { "google" } else { "openai" });
    if provider == "google" {
        let google = state
            .google
            .as_ref()
            .ok_or_else(|| ApiError::bad_request("Google is not configured; set google.project_id in TOML"))?;
        return google.transcribe(upload).await;
    }
    if state.api_key.is_empty() {
        return Err(ApiError::bad_request(
            "OpenAI is not configured; set openai_api_key in TOML",
        ));
    }
    let form = openai_form(upload, &state.model)?;
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
        "provider": "openai",
        "model": state.model,
        "elapsed_ms": started.elapsed().as_millis(),
        "request_id": request_id
    }))
    .into_response())
}

#[cfg(test)]
mod tests;
