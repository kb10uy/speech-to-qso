//! Standalone file-transcription experiment. Interpretation stays in the QSO DSL parser.

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, State, multipart::MultipartError},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;

const MAX_AUDIO_BYTES: usize = 25_000_000;
// Leave room for multipart headers and transcription hints above the file limit.
const MAX_BODY_BYTES: usize = MAX_AUDIO_BYTES + 64 * 1024;

pub mod config;
mod google;
mod google_v1;
mod openai;

pub struct AppState {
    client: reqwest::Client,
    model: String,
    openai: Option<openai::OpenaiState>,
    google: Option<google::GoogleState>,
    google_v1: Option<google_v1::GoogleV1State>,
}

impl AppState {
    pub fn new(api_key: String, model: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            openai: (!api_key.is_empty())
                .then(|| openai::OpenaiState::new(&client, &api_key, model.clone(), openai::API_BASE)),
            client,
            model,
            google: None,
            google_v1: None,
        })
    }

    pub fn with_google(mut self, config: Option<config::GoogleConfig>) -> Self {
        self.google_v1 = config
            .as_ref()
            .map(|config| google_v1::GoogleV1State::new(config.clone()));
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
    if state.openai.is_some() {
        providers.push(json!({ "id": "openai", "label": "OpenAI", "model": state.model }));
    }
    if let Some(google) = &state.google {
        providers.push(json!({ "id": "google", "label": "Google Cloud STT V2", "model": google.config.model }));
        providers.push(json!({ "id": "google-v1", "label": "Google V1 / ABNF", "model": google.config.v1_model }));
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
    provider: Option<String>,
    prompt: Option<String>,
    keywords: Vec<String>,
    languages: Vec<String>,
    boost: Option<f32>,
    abnf: Option<String>,
}

async fn read_upload(mut multipart: Multipart) -> Result<Upload, ApiError> {
    let mut file = None;
    let mut prompt = None;
    let mut provider = None;
    let mut boost = None;
    let mut abnf = None;
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
                file = Some((bytes.to_vec(), filename));
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
                if !matches!(value.as_str(), "openai" | "google" | "google-v1") {
                    return Err(ApiError::bad_request("provider must be openai, google or google-v1"));
                }
                provider = Some(value);
            }
            "abnf" => {
                if abnf.is_some() {
                    return Err(ApiError::bad_request("send at most one ABNF grammar"));
                }
                let value = field.text().await?;
                if value.trim().is_empty() || value.len() > 64 * 1024 {
                    return Err(ApiError::bad_request("ABNF must be nonempty and at most 64 KiB"));
                }
                abnf = Some(value);
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
    let (bytes, filename) = file.ok_or_else(|| ApiError::bad_request("file is required"))?;
    Ok(Upload {
        bytes,
        filename,
        provider,
        prompt,
        keywords,
        languages,
        boost,
        abnf,
    })
}

async fn transcribe(State(state): State<Arc<AppState>>, multipart: Multipart) -> Result<Response, ApiError> {
    let upload = read_upload(multipart).await?;
    let provider = upload
        .provider
        .as_deref()
        .unwrap_or(if state.openai.is_some() { "openai" } else { "google" });
    if provider == "google" {
        let google = state
            .google
            .as_ref()
            .ok_or_else(|| ApiError::bad_request("Google is not configured; set google.project_id in TOML"))?;
        return google.transcribe(upload).await;
    }
    if provider == "google-v1" {
        let google = state
            .google_v1
            .as_ref()
            .ok_or_else(|| ApiError::bad_request("Google is not configured; set google.project_id in TOML"))?;
        return google.transcribe(&state.client, upload).await;
    }
    let openai = state
        .openai
        .as_ref()
        .ok_or_else(|| ApiError::bad_request("OpenAI is not configured; set openai.api_key in TOML"))?;
    openai.transcribe(upload).await
}

#[cfg(test)]
mod tests;
