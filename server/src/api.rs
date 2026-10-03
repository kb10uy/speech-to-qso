//! HTTP API.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use tokio::sync::Mutex;
use tower_http::{
    cors::{AllowOrigin, Any, CorsLayer},
    trace::TraceLayer,
};

use crate::{adif, config::Config, qso::QsoPayload, store::Store, wavelog::WavelogClient};

pub struct AppState {
    pub api_token: Option<String>,
    /// Serialises writes and uploads so that a QSO is never uploaded twice concurrently.
    pub store: Mutex<Store>,
    pub wavelog: Option<WavelogClient>,
}

impl AppState {
    pub async fn new(config: &Config) -> std::io::Result<Self> {
        Ok(Self {
            api_token: config.api_token.clone(),
            store: Mutex::new(Store::open(&config.data_dir).await?),
            wavelog: config.wavelog.clone().map(WavelogClient::new),
        })
    }
}

pub fn router(state: Arc<AppState>, allowed_origins: &[String]) -> Router {
    let origins = if allowed_origins.is_empty() {
        AllowOrigin::from(Any)
    } else {
        AllowOrigin::list(allowed_origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()))
    };
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Router::new()
        .route("/api/health", get(health))
        .route("/api/qso", post(post_qso))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "status": "error", "error": message.into() }))).into_response()
}

/// Constant-time comparison so the token cannot be guessed byte by byte.
fn token_matches(expected: &str, given: &str) -> bool {
    expected.len() == given.len()
        && expected
            .bytes()
            .zip(given.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = &state.api_token else {
        return true;
    };
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|given| token_matches(expected, given.trim()))
}

async fn health(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "status": "ok", "wavelog": state.wavelog.is_some() })).into_response()
}

async fn post_qso(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<QsoPayload>, JsonRejection>,
) -> Response {
    if !authorized(&state, &headers) {
        return error(StatusCode::UNAUTHORIZED, "missing or invalid bearer token");
    }
    let Json(qso) = match payload {
        Ok(p) => p,
        Err(rejection) => return error(rejection.status(), rejection.body_text()),
    };
    if let Err(e) = qso.validate() {
        return error(StatusCode::UNPROCESSABLE_ENTITY, e.to_string());
    }

    let mut store = state.store.lock().await;
    let existing = store.get(&qso.id);
    if existing.is_none()
        && let Err(e) = store.record_received(&qso).await
    {
        tracing::error!("failed to store QSO {}: {e}", qso.id);
        return error(StatusCode::INTERNAL_SERVER_ERROR, "failed to store QSO");
    }

    if let Some(wavelog) = &state.wavelog
        && !existing.is_some_and(|e| e.forwarded)
    {
        if let Err(e) = wavelog
            .upload(&adif::record(&qso), qso.station_profile_id.as_deref())
            .await
        {
            tracing::warn!("Wavelog upload of {} failed: {e}", qso.id);
            // Stored locally; the client retries and the upload is attempted again.
            return error(StatusCode::BAD_GATEWAY, e.to_string());
        }
        if let Err(e) = store.record_forwarded(&qso.id).await {
            tracing::error!("failed to record upload of {}: {e}", qso.id);
        }
    }

    let (status, label) = match existing {
        None => (StatusCode::CREATED, "created"),
        Some(_) => (StatusCode::OK, "duplicate"),
    };
    tracing::info!("QSO {} {} ({})", qso.call, qso.id, label);
    (status, Json(json!({ "status": label, "id": qso.id }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::WavelogConfig, qso::tests::sample};
    use axum::body::Body;
    use http_body_util::BodyExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    struct Harness {
        app: Router,
        dir: tempfile::TempDir,
    }

    async fn harness(token: Option<&str>, wavelog: Option<WavelogConfig>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            api_token: token.map(Into::into),
            allowed_origins: vec!["https://kb10uy.github.io".into()],
            data_dir: dir.path().into(),
            wavelog,
        };
        let state = Arc::new(AppState::new(&config).await.unwrap());
        Harness {
            app: router(state, &config.allowed_origins),
            dir,
        }
    }

    async fn send(app: &Router, token: Option<&str>, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
        let mut req = axum::http::Request::post("/api/qso").header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn body() -> serde_json::Value {
        serde_json::to_value(sample()).unwrap()
    }

    /// A fake Wavelog that counts uploads and fails while `fail` is set.
    async fn fake_wavelog(fail: bool) -> (String, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let app = Router::new().route(
            "/index.php/api/qso",
            post(move |Json(req): Json<serde_json::Value>| {
                let counter = counter.clone();
                async move {
                    assert_eq!(req["key"], "wl-key");
                    assert_eq!(req["type"], "adif");
                    assert_eq!(req["station_profile_id"], "3");
                    assert!(req["string"].as_str().unwrap().starts_with("<CALL:6>JL1HIS "));
                    counter.fetch_add(1, Ordering::SeqCst);
                    if fail {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"status": "failed", "reason": "nope"})),
                        )
                    } else {
                        (StatusCode::CREATED, Json(json!({"status": "created"})))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, count)
    }

    fn wavelog_config(url: String) -> WavelogConfig {
        WavelogConfig {
            url,
            api_key: "wl-key".into(),
            default_station_profile_id: Some("3".into()),
        }
    }

    #[tokio::test]
    async fn requires_the_bearer_token() {
        let h = harness(Some("secret"), None).await;
        assert_eq!(send(&h.app, None, body()).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(&h.app, Some("wrong"), body()).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(&h.app, Some("secret"), body()).await.0, StatusCode::CREATED);
    }

    #[tokio::test]
    async fn stores_qsos_and_deduplicates_retries() {
        let h = harness(None, None).await;
        let (status, json) = send(&h.app, None, body()).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(json["status"], "created");

        let (status, json) = send(&h.app, None, body()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["status"], "duplicate");

        let adif = std::fs::read_to_string(h.dir.path().join("log.adi")).unwrap();
        assert_eq!(adif.matches("<EOR>").count(), 1);
    }

    #[tokio::test]
    async fn rejects_invalid_payloads() {
        let h = harness(None, None).await;
        let mut bad = body();
        bad["rst_rcvd"] = json!("99");
        let (status, json) = send(&h.app, None, bad).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(json["error"].as_str().unwrap().contains("rst_rcvd"));

        let (status, _) = send(&h.app, None, json!({"id": "x"})).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn uploads_to_wavelog_once() {
        let (url, count) = fake_wavelog(false).await;
        let h = harness(None, Some(wavelog_config(url))).await;
        assert_eq!(send(&h.app, None, body()).await.0, StatusCode::CREATED);
        assert_eq!(send(&h.app, None, body()).await.0, StatusCode::OK);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reports_wavelog_failures_so_the_client_retries() {
        let (url, count) = fake_wavelog(true).await;
        let h = harness(None, Some(wavelog_config(url))).await;
        let (status, json) = send(&h.app, None, body()).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(json["error"].as_str().unwrap().contains("HTTP 400"));
        // The retry is stored already but uploads again.
        assert_eq!(send(&h.app, None, body()).await.0, StatusCode::BAD_GATEWAY);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        let adif = std::fs::read_to_string(h.dir.path().join("log.adi")).unwrap();
        assert_eq!(adif.matches("<EOR>").count(), 1);
    }

    #[tokio::test]
    async fn answers_cors_preflight_for_allowed_origins() {
        let h = harness(None, None).await;
        let req = axum::http::Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/qso")
            .header(header::ORIGIN, "https://kb10uy.github.io")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization,content-type")
            .body(Body::empty())
            .unwrap();
        let response = h.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://kb10uy.github.io"
        );
    }

    #[test]
    fn compares_tokens() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "abcd"));
    }
}
