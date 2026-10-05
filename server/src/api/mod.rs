//! HTTP API, and the web app on the same origin.

mod auth;
mod qso;
mod stations;

use std::{path::Path, sync::Arc};

use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderValue, Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post, put},
};
use serde_json::json;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use url::Url;
use webauthn_rs::{Webauthn, WebauthnBuilder};

pub use auth::{Ceremonies, SESSION_COOKIE};

use crate::{
    config::origin_of,
    db::Db,
    error::{Error, Result},
    wavelog::WavelogClient,
};

pub struct AppState {
    pub db: Db,
    pub webauthn: Webauthn,
    /// The `Origin` browsers send for this app, e.g. `https://qso.example.com`.
    pub origin: String,
    pub ceremonies: Ceremonies,
    pub wavelog: WavelogClient,
    /// Serialises forwarding so that a QSO is never uploaded twice concurrently.
    pub forward_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn new(db: Db, public_origin: &Url) -> Result<Self> {
        let rp_id = public_origin
            .host_str()
            .ok_or_else(|| Error::Internal("public origin without a host".into()))?;
        let webauthn = WebauthnBuilder::new(rp_id, public_origin)
            .and_then(|b| b.rp_name("Speech to QSO").build())
            .map_err(|e| Error::Internal(format!("WebAuthn: {e}")))?;
        Ok(Self {
            db,
            webauthn,
            origin: origin_of(public_origin),
            ceremonies: Ceremonies::default(),
            wavelog: WavelogClient::new(),
            forward_lock: tokio::sync::Mutex::new(()),
        })
    }
}

/// Rejects state-changing requests from other origins (CSRF). Browsers always send `Origin` on
/// such requests; clients that send neither header are not browsers and carry no ambient cookie.
async fn same_origin_only(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        let headers = request.headers();
        let foreign_origin = headers
            .get(header::ORIGIN)
            .is_some_and(|o| o.as_bytes() != state.origin.as_bytes());
        let cross_site = headers
            .get("sec-fetch-site")
            .is_some_and(|s| s != "same-origin" && s != "none");
        if foreign_origin || cross_site {
            return Error::Forbidden("cross-origin request".into()).into_response();
        }
    }
    next.run(request).await
}

async fn health() -> Response {
    axum::Json(json!({ "status": "ok" })).into_response()
}

async fn api_not_found() -> Response {
    Error::NotFound("no such API".into()).into_response()
}

pub fn router(state: Arc<AppState>, web_dir: Option<&Path>) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(auth::me))
        .route("/api/auth/login/start", post(auth::login_start))
        .route("/api/auth/login/finish", post(auth::login_finish))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/bootstrap/start", post(auth::bootstrap_start))
        .route("/api/auth/bootstrap/finish", post(auth::bootstrap_finish))
        .route("/api/passkeys", get(auth::list_passkeys))
        .route("/api/passkeys/register/start", post(auth::passkey_registration_start))
        .route("/api/passkeys/register/finish", post(auth::passkey_registration_finish))
        .route(
            "/api/passkeys/{id}",
            put(auth::rename_passkey).delete(auth::delete_passkey),
        )
        .route(
            "/api/wavelog",
            get(stations::get_wavelog)
                .put(stations::put_wavelog)
                .delete(stations::delete_wavelog),
        )
        .route(
            "/api/stations",
            get(stations::list_stations).post(stations::create_station),
        )
        .route("/api/stations/refresh", post(stations::refresh_stations))
        .route("/api/stations/default", put(stations::set_default_station))
        .route(
            "/api/stations/{id}",
            put(stations::update_station).delete(stations::delete_station),
        )
        .route("/api/qso", post(qso::post_qso))
        .route("/api/qso.adi", get(qso::export_adif))
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .layer(middleware::from_fn_with_state(state.clone(), same_origin_only))
        .with_state(state);

    let app = match web_dir {
        Some(dir) => {
            // Build output under _app/immutable has content hashes in its names.
            let immutable = ServeDir::new(dir.join("_app").join("immutable"));
            let immutable = tower::ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                ))
                .service(immutable);
            // Every other path is the single-page app.
            let files = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
            api.nest_service("/_app/immutable", immutable).fallback_service(files)
        }
        None => api,
    };
    app.layer(TraceLayer::new_for_http())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db, logbook,
        qso::tests::sample,
        sessions,
        users::{self, User},
    };
    use axum::{
        Json,
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use serde_json::Value;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use tower::ServiceExt;

    const ORIGIN: &str = "https://qso.example.com";

    pub fn webauthn() -> Webauthn {
        let url = Url::parse(ORIGIN).unwrap();
        WebauthnBuilder::new("qso.example.com", &url).unwrap().build().unwrap()
    }

    struct Harness {
        app: Router,
        db: Db,
        user: User,
        cookie: String,
    }

    async fn harness(web_dir: Option<&Path>) -> Harness {
        let db = db::open_in_memory().await.unwrap();
        let state = Arc::new(AppState::new(db.clone(), &Url::parse(ORIGIN).unwrap()).unwrap());
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let token = sessions::create(&db, user.id).await.unwrap();
        Harness {
            app: router(state, web_dir),
            db,
            user,
            cookie: format!("{SESSION_COOKIE}={token}"),
        }
    }

    impl Harness {
        async fn request(
            &self,
            method: Method,
            uri: &str,
            body: Option<Value>,
            signed_in: bool,
        ) -> (StatusCode, Value) {
            let mut req = Request::builder()
                .method(method)
                .uri(uri)
                .header(header::ORIGIN, ORIGIN);
            if signed_in {
                req = req.header(header::COOKIE, &self.cookie);
            }
            let body = match body {
                Some(body) => {
                    req = req.header(header::CONTENT_TYPE, "application/json");
                    Body::from(body.to_string())
                }
                None => Body::empty(),
            };
            let response = self.app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }

        async fn get(&self, uri: &str) -> (StatusCode, Value) {
            self.request(Method::GET, uri, None, true).await
        }

        async fn post(&self, uri: &str, body: Value) -> (StatusCode, Value) {
            self.request(Method::POST, uri, Some(body), true).await
        }

        async fn put(&self, uri: &str, body: Value) -> (StatusCode, Value) {
            self.request(Method::PUT, uri, Some(body), true).await
        }
    }

    fn qso_body() -> Value {
        serde_json::to_value(sample()).unwrap()
    }

    /// A fake Wavelog API v2: two station locations; uploads are recorded and fail while `fail`.
    struct FakeWavelog {
        url: String,
        uploads: Arc<Mutex<Vec<Value>>>,
        fail: Arc<AtomicBool>,
    }

    async fn fake_wavelog() -> FakeWavelog {
        let uploads = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicBool::new(false));
        let authorized = |headers: &axum::http::HeaderMap| {
            headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some("Bearer wl2_token")
        };
        let app = Router::new()
            .route(
                "/index.php/api/v2/station",
                get(move |headers: axum::http::HeaderMap| async move {
                    if !authorized(&headers) {
                        let error = json!({"error": {"code": "unauthorized", "message": "invalid token"}});
                        return (StatusCode::UNAUTHORIZED, Json(error));
                    }
                    let stations = json!({"data": [
                        {"id": 1, "name": "Home", "callsign": "JJ1ABC", "city": "Minato", "active": true},
                        {"id": 2, "name": "Park", "callsign": "JJ1ABC/1", "pota": "JP-0001", "active": false}
                    ], "meta": {}});
                    (StatusCode::OK, Json(stations))
                }),
            )
            .route(
                "/index.php/api/v2/qso",
                post({
                    let uploads = uploads.clone();
                    let fail = fail.clone();
                    move |headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                        assert!(authorized(&headers));
                        uploads.lock().unwrap().push(body);
                        if fail.load(Ordering::SeqCst) {
                            let error = json!({"error": {"code": "validation_error", "message": "nope"}});
                            (StatusCode::BAD_REQUEST, Json(error))
                        } else {
                            (StatusCode::CREATED, Json(json!({"data": {"id": 4886}})))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeWavelog { url, uploads, fail }
    }

    #[tokio::test]
    async fn requires_a_session() {
        let h = harness(None).await;
        for (method, uri) in [
            (Method::GET, "/api/me"),
            (Method::GET, "/api/passkeys"),
            (Method::GET, "/api/stations"),
            (Method::GET, "/api/wavelog"),
            (Method::GET, "/api/qso.adi"),
            (Method::POST, "/api/qso"),
        ] {
            let body = (method == Method::POST).then(qso_body);
            let (status, _) = h.request(method.clone(), uri, body, false).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
        let (status, me) = h.get("/api/me").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["callsign"], "JJ1ABC");
        assert_eq!(me["id"], h.user.id.to_string());
    }

    #[tokio::test]
    async fn logout_ends_the_session() {
        let h = harness(None).await;
        let (status, _) = h.request(Method::POST, "/api/auth/logout", None, true).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(h.get("/api/me").await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_cross_origin_writes() {
        let h = harness(None).await;
        for (name, value) in [("origin", "https://evil.example.com"), ("sec-fetch-site", "same-site")] {
            let req = Request::post("/api/qso")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, &h.cookie)
                .header(name, value)
                .body(Body::from(qso_body().to_string()))
                .unwrap();
            let response = h.app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{name}");
        }
        // Reads are fine (and cannot be read cross-origin without CORS anyway).
        let req = Request::get("/api/me")
            .header(header::COOKIE, &h.cookie)
            .header(header::ORIGIN, "https://evil.example.com")
            .body(Body::empty())
            .unwrap();
        assert_eq!(h.app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn bootstrap_links_only_work_before_the_first_passkey() {
        let h = harness(None).await;
        let (status, _) = h
            .request(
                Method::POST,
                "/api/auth/bootstrap/start",
                Some(json!({"token": "forged"})),
                false,
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let token = sessions::issue_bootstrap_token(&h.db, h.user.id, chrono::TimeDelta::minutes(10))
            .await
            .unwrap();
        let (status, json) = h
            .request(
                Method::POST,
                "/api/auth/bootstrap/start",
                Some(json!({"token": token})),
                false,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["callsign"], "JJ1ABC");
        assert_eq!(json["options"]["publicKey"]["rp"]["id"], "qso.example.com");
        assert_eq!(
            json["options"]["publicKey"]["authenticatorSelection"]["residentKey"],
            "required"
        );

        sqlx::query(
            "INSERT INTO passkeys (id, user_id, credential_id, passkey, name, created_at) \
             VALUES ('p', ?, x'00', '{}', 'Passkey', '')",
        )
        .bind(h.user.id.to_string())
        .execute(&h.db)
        .await
        .unwrap();
        let (status, json) = h
            .request(
                Method::POST,
                "/api/auth/bootstrap/start",
                Some(json!({"token": token})),
                false,
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(json["error"].as_str().unwrap().contains("already has a passkey"));
    }

    #[tokio::test]
    async fn login_start_issues_a_discoverable_challenge() {
        let h = harness(None).await;
        let (status, json) = h.request(Method::POST, "/api/auth/login/start", None, false).await;
        assert_eq!(status, StatusCode::OK);
        assert!(json["ceremony"].as_str().is_some_and(|c| !c.is_empty()));
        assert!(json["options"]["publicKey"]["challenge"].is_string());
        assert!(json["options"].get("mediation").is_none());

        let finish = json!({"ceremony": "unknown", "credential": {
            "id": "AA", "rawId": "AA", "type": "public-key",
            "response": {"authenticatorData": "AA", "clientDataJSON": "AA", "signature": "AA"}
        }});
        let (status, _) = h
            .request(Method::POST, "/api/auth/login/finish", Some(finish), false)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn stores_qsos_and_deduplicates_retries() {
        let h = harness(None).await;
        let (status, json) = h.post("/api/qso", qso_body()).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(json["status"], "created");
        assert_eq!(json["forwarded"], false);

        let (status, json) = h.post("/api/qso", qso_body()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["status"], "duplicate");
        assert_eq!(logbook::list(&h.db, h.user.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn rejects_invalid_payloads() {
        let h = harness(None).await;
        let mut bad = qso_body();
        bad["rst_rcvd"] = json!("99");
        let (status, json) = h.post("/api/qso", bad).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(json["error"].as_str().unwrap().contains("rst_rcvd"));

        assert_eq!(
            h.post("/api/qso", json!({"id": "x"})).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let mut unknown_station = qso_body();
        unknown_station["station_id"] = json!("nope");
        assert_eq!(
            h.post("/api/qso", unknown_station).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[tokio::test]
    async fn connects_wavelog_and_forwards_qsos_once() {
        let wavelog = fake_wavelog().await;
        let h = harness(None).await;

        let (status, json) = h
            .put("/api/wavelog", json!({"url": wavelog.url, "token": "wrong"}))
            .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(json["error"].as_str().unwrap().contains("invalid token"));
        assert_eq!(h.get("/api/wavelog").await.1["configured"], false);

        let (status, list) = h
            .put(
                "/api/wavelog",
                json!({"url": format!("{}/index.php/dashboard", wavelog.url), "token": "wl2_token"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["stations"].as_array().unwrap().len(), 2);
        let home = list["stations"][0]["id"].clone();
        let park = list["stations"][1]["id"].clone();
        assert_eq!(list["default_station_id"], home);
        let settings = h.get("/api/wavelog").await.1;
        assert_eq!(settings, json!({"configured": true, "url": wavelog.url}));

        // Without a station the default (Home, Wavelog id 1) is used.
        let (status, json) = h.post("/api/qso", qso_body()).await;
        assert_eq!((status, json["forwarded"].clone()), (StatusCode::CREATED, json!(true)));
        let mut at_park = qso_body();
        at_park["id"] = json!("uuid-2");
        at_park["station_id"] = park;
        assert_eq!(h.post("/api/qso", at_park).await.0, StatusCode::CREATED);
        assert_eq!(h.post("/api/qso", qso_body()).await.0, StatusCode::OK);

        let uploads = wavelog.uploads.lock().unwrap().clone();
        assert_eq!(uploads.len(), 2);
        assert_eq!(uploads[0]["station_profile_id"], 1);
        assert_eq!(uploads[0]["call"], "JL1HIS");
        assert_eq!(uploads[1]["station_profile_id"], 2);

        // The token can be kept while changing the URL.
        let (status, _) = h.put("/api/wavelog", json!({"url": wavelog.url})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(h.post("/api/stations/refresh", json!({})).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn reports_wavelog_failures_so_the_client_retries() {
        let wavelog = fake_wavelog().await;
        let h = harness(None).await;
        h.put("/api/wavelog", json!({"url": wavelog.url, "token": "wl2_token"}))
            .await;
        wavelog.fail.store(true, Ordering::SeqCst);

        let (status, json) = h.post("/api/qso", qso_body()).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(json["error"].as_str().unwrap().contains("validation_error: nope"));
        // The retry is stored already but uploads again.
        assert_eq!(h.post("/api/qso", qso_body()).await.0, StatusCode::BAD_GATEWAY);
        wavelog.fail.store(false, Ordering::SeqCst);
        let (status, json) = h.post("/api/qso", qso_body()).await;
        assert_eq!((status, json["forwarded"].clone()), (StatusCode::OK, json!(true)));
        assert_eq!(wavelog.uploads.lock().unwrap().len(), 3);
        assert_eq!(logbook::list(&h.db, h.user.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn manages_stations_and_the_default() {
        let h = harness(None).await;
        let (status, station) = h
            .post(
                "/api/stations",
                json!({"name": "Park", "callsign": "jj1abc/1", "city": "Minato"}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = station["id"].as_str().unwrap();
        assert_eq!(h.get("/api/stations").await.1["default_station_id"], id);

        let (status, station) = h
            .put(
                &format!("/api/stations/{id}"),
                json!({"name": "Hill", "callsign": "JJ1ABC/1"}),
            )
            .await;
        assert_eq!((status, station["name"].clone()), (StatusCode::OK, json!("Hill")));

        let (status, _) = h.put("/api/stations/default", json!({"station_id": null})).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(h.get("/api/stations").await.1["default_station_id"], Value::Null);

        // Stations entered by hand never reach Wavelog.
        let mut qso = qso_body();
        qso["station_id"] = json!(id);
        assert_eq!(h.post("/api/qso", qso).await.1["forwarded"], false);

        let (status, _) = h
            .request(Method::DELETE, &format!("/api/stations/{id}"), None, true)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(h.post("/api/stations/refresh", json!({})).await.0, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn exports_adif() {
        let h = harness(None).await;
        h.post("/api/qso", qso_body()).await;
        let req = Request::get("/api/qso.adi")
            .header(header::COOKIE, &h.cookie)
            .body(Body::empty())
            .unwrap();
        let response = h.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"JJ1ABC.adi\""
        );
        let text = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(text.contains("<EOH>"));
        assert_eq!(text.matches("<EOR>").count(), 1);
    }

    #[tokio::test]
    async fn serves_the_web_app_and_json_errors_for_unknown_apis() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>app").unwrap();
        std::fs::create_dir_all(dir.path().join("_app/immutable")).unwrap();
        std::fs::write(dir.path().join("_app/immutable/a.js"), "js").unwrap();
        let h = harness(Some(dir.path())).await;

        let get = |uri: &str| {
            let app = h.app.clone();
            let req = Request::get(uri).body(Body::empty()).unwrap();
            async move { app.oneshot(req).await.unwrap() }
        };
        let response = get("/").await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = get("/some/route").await;
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"<!doctype html>app");

        let response = get("/_app/immutable/a.js").await;
        assert!(
            response.headers()[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .contains("immutable")
        );

        let (status, json) = h.get("/api/nope").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json["status"], "error");
    }
}
