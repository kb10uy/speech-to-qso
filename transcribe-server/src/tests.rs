use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use std::sync::Mutex;
use tower::ServiceExt;

const AUDIO: &[u8] = b"RIFF\0\0\0\0WAVE\0\xff";
const BOUNDARY: &str = "qso-test-boundary";

#[derive(Debug)]
struct UploadedField {
    name: String,
    filename: Option<String>,
    bytes: Vec<u8>,
}

struct Mock {
    task: tokio::task::JoinHandle<()>,
    fields: Arc<Mutex<Vec<UploadedField>>>,
    app: Router,
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn mock(status: StatusCode, response: serde_json::Value) -> Mock {
    let fields = Arc::new(Mutex::new(Vec::new()));
    let captured = fields.clone();
    let upstream = Router::new().route(
        "/v1/audio/transcriptions",
        post(move |headers: axum::http::HeaderMap, mut multipart: Multipart| {
            let captured = captured.clone();
            let response = response.clone();
            async move {
                assert_eq!(headers["authorization"], "Bearer test-key");
                while let Some(field) = multipart.next_field().await.unwrap() {
                    let name = field.name().unwrap().to_owned();
                    let filename = field.file_name().map(str::to_owned);
                    let bytes = field.bytes().await.unwrap().to_vec();
                    captured.lock().unwrap().push(UploadedField { name, filename, bytes });
                }
                (status, Json(response))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = AppState::new("test-key".into(), "gpt-transcribe".into()).unwrap();
    state.openai = Some(openai::OpenaiState::new(
        &state.client,
        "test-key",
        "gpt-transcribe".into(),
        &api_base,
    ));
    Mock {
        task,
        fields,
        app: router(Arc::new(state)),
    }
}

fn upload(fields: &[(&str, &str)], audio: Option<&[u8]>) -> Request<Body> {
    let mut body = Vec::new();
    if let Some(audio) = audio {
        body.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"utterance.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(audio);
        body.extend_from_slice(b"\r\n");
    }
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    Request::post("/api/transcribe")
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(body))
        .unwrap()
}

async fn response(app: Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn forwards_audio_and_hints_without_rewriting_transcript() {
    let mock = mock(StatusCode::OK, json!({ "text": "JCX 01008." })).await;
    let hints = [
        ("prompt", "English radio command"),
        ("keywords[]", "JCX"),
        ("keywords[]", "QSL"),
        ("languages[]", "en"),
        ("languages[]", "ja"),
    ];
    let (status, result) = response(mock.app.clone(), upload(&hints, Some(AUDIO))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["text"], "JCX 01008.");
    assert_eq!(result["model"], "gpt-transcribe");
    assert!(result["elapsed_ms"].is_u64());

    let fields = mock.fields.lock().unwrap();
    let values = |name: &str| {
        fields
            .iter()
            .filter(|field| field.name == name)
            .map(|field| String::from_utf8(field.bytes.clone()).unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(values("model"), ["gpt-transcribe"]);
    assert_eq!(values("response_format"), ["json"]);
    assert_eq!(values("prompt"), ["English radio command"]);
    assert_eq!(values("keywords[]"), ["JCX", "QSL"]);
    assert_eq!(values("languages[]"), ["en", "ja"]);
    let file = fields.iter().find(|field| field.name == "file").unwrap();
    assert_eq!(file.filename.as_deref(), Some("utterance.wav"));
    assert_eq!(file.bytes, AUDIO);
}

#[tokio::test]
async fn baseline_only_adds_english_language_hint() {
    let mock = mock(StatusCode::OK, json!({ "text": "received five seven" })).await;
    let (status, _) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::OK);
    let fields = mock.fields.lock().unwrap();
    assert_eq!(fields.len(), 4);
    let languages: Vec<_> = fields.iter().filter(|field| field.name == "languages[]").collect();
    assert_eq!(languages.len(), 1);
    assert_eq!(languages[0].bytes, b"en");
}

#[tokio::test]
async fn rejects_invalid_uploads_before_contacting_openai() {
    let mock = mock(StatusCode::OK, json!({ "text": "unexpected" })).await;
    for request in [
        upload(&[("prompt", "no audio")], None),
        upload(&[], Some(b"")),
        upload(&[("file", "duplicate")], Some(AUDIO)),
        upload(&[("prompt", "a"), ("prompt", "b")], Some(AUDIO)),
        upload(&[("keywords[]", "bad\nkeyword")], Some(AUDIO)),
        upload(&[("languages[]", " ")], Some(AUDIO)),
        upload(&[("model", "unexpected")], Some(AUDIO)),
    ] {
        let (status, result) = response(mock.app.clone(), request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
        assert!(result["error"].is_string());
    }
    assert!(mock.fields.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejects_oversize_audio_before_contacting_openai() {
    let mock = mock(StatusCode::OK, json!({ "text": "unexpected" })).await;
    for size in [MAX_AUDIO_BYTES + 1, MAX_BODY_BYTES + 1] {
        let (status, _) = response(mock.app.clone(), upload(&[], Some(&vec![0; size]))).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }
    assert!(mock.fields.lock().unwrap().is_empty());
}

#[tokio::test]
async fn upstream_errors_do_not_expose_provider_body() {
    let mock = mock(StatusCode::UNAUTHORIZED, json!({ "error": { "message": "test-key" } })).await;
    let (status, result) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(result["upstream_status"], 401);
    assert_eq!(mock.fields.lock().unwrap().len(), 4);
    assert!(!result.to_string().contains("test-key"));
}

#[tokio::test]
async fn retryable_upstream_errors_are_not_retried() {
    for upstream in [StatusCode::TOO_MANY_REQUESTS, StatusCode::SERVICE_UNAVAILABLE] {
        let mock = mock(upstream, json!({ "error": { "message": "retry me" } })).await;
        let (status, result) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(result["upstream_status"], upstream.as_u16());
        assert_eq!(mock.fields.lock().unwrap().len(), 4);
    }
}

#[tokio::test]
async fn malformed_upstream_response_is_a_gateway_error() {
    let mock = mock(StatusCode::OK, json!({ "wrong_field": "text" })).await;
    let (status, result) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(result["error"], "invalid OpenAI transcription response");
}

struct GoogleMock {
    task: tokio::task::JoinHandle<()>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    app: Router,
}

impl Drop for GoogleMock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn google_mock(status: StatusCode, body: serde_json::Value) -> GoogleMock {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let upstream = Router::new().route(
        "/v2/projects/radio-lab/locations/global/recognizers/_:recognize",
        post(
            move |headers: axum::http::HeaderMap, Json(request): Json<serde_json::Value>| {
                let captured = captured.clone();
                let body = body.clone();
                async move {
                    // Never use developer ADC credentials for mock requests.
                    assert!(!headers.contains_key("authorization"));
                    captured.lock().unwrap().push(request);
                    (status, Json(body))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let client = google_cloud_speech_v2::client::Speech::builder()
        .with_endpoint(endpoint)
        .with_credentials(google_cloud_auth::credentials::anonymous::Builder::new().build())
        .build()
        .await
        .unwrap();
    let state = AppState::new(String::new(), "gpt-transcribe".into())
        .unwrap()
        .with_google(Some(config::GoogleConfig {
            project_id: "radio-lab".into(),
            ..Default::default()
        }));
    state.google.as_ref().unwrap().client.set(client).unwrap();
    GoogleMock {
        task,
        requests,
        app: router(Arc::new(state)),
    }
}

#[tokio::test]
async fn google_sdk_forwards_audio_phrase_boost_and_bcp47_languages() {
    let mock = google_mock(
        StatusCode::OK,
        json!({ "results": [
        { "alternatives": [{ "transcript": "tango JCX 01008.", "confidence": 0.9 }] },
        { "alternatives": [{ "transcript": "received five seven" }] }
    ] }),
    )
    .await;
    let (status, result) = response(
        mock.app.clone(),
        upload(
            &[
                ("provider", "google"),
                ("keywords[]", "tango"),
                ("keywords[]", "JCX"),
                ("boost", "12"),
                ("languages[]", "en-US"),
                ("languages[]", "ja-JP"),
            ],
            Some(AUDIO),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["provider"], "google");
    assert_eq!(result["model"], "short");
    assert_eq!(result["text"], "tango JCX 01008.\nreceived five seven");
    assert_eq!(result["results"].as_array().unwrap().len(), 2);
    assert!(result["elapsed_ms"].is_u64());
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    let parsed: google_cloud_speech_v2::model::RecognizeRequest = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(parsed.content().unwrap().as_ref(), AUDIO);
    assert_eq!(request["config"]["model"], "short");
    assert_eq!(request["config"]["languageCodes"], json!(["en-US", "ja-JP"]));
    assert_eq!(request["config"]["autoDecodingConfig"], json!({}));
    let phrase_set = &request["config"]["adaptation"]["phraseSets"][0]["inlinePhraseSet"];
    assert_eq!(phrase_set["boost"].as_f64(), Some(12.0));
    assert_eq!(phrase_set["phrases"], json!([{ "value": "tango" }, { "value": "JCX" }]));
}

#[tokio::test]
async fn google_only_defaults_to_english_without_adaptation_and_accepts_empty_results() {
    let mock = google_mock(StatusCode::OK, json!({})).await;
    let (status, result) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["text"], "");
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests[0]["config"]["languageCodes"], json!(["en-US"]));
    assert!(requests[0]["config"].get("adaptation").is_none());
}

#[tokio::test]
async fn google_validates_unsupported_hints_size_and_provider_selection() {
    let mock = google_mock(StatusCode::OK, json!({})).await;
    for fields in [
        vec![("provider", "openai")],
        vec![("provider", "unknown")],
        vec![("provider", "google"), ("provider", "google")],
        vec![("prompt", "unsupported")],
        vec![("boost", "NaN")],
        vec![("boost", "21")],
        vec![("boost", "1"), ("boost", "2")],
        vec![
            ("languages[]", "en-US"),
            ("languages[]", "ja-JP"),
            ("languages[]", "en-GB"),
            ("languages[]", "fr-FR"),
        ],
    ] {
        let (status, result) = response(mock.app.clone(), upload(&fields, Some(AUDIO))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    }
    let (status, _) = response(mock.app.clone(), upload(&[], Some(&vec![0; 10_000_001]))).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(mock.requests.lock().unwrap().is_empty());
    let openai = self::mock(StatusCode::OK, json!({ "text": "unused" })).await;
    let (status, _) = response(openai.app.clone(), upload(&[("provider", "google")], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn google_errors_are_redacted_and_are_not_retried() {
    let mock = google_mock(StatusCode::FORBIDDEN,
        json!({ "error": { "code": 403, "status": "PERMISSION_DENIED", "message": "secret-token uploaded transcript" } })).await;
    let (status, result) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(result["upstream_status"], 403);
    assert_eq!(result["upstream_code"], "PermissionDenied");
    assert!(!result.to_string().contains("secret-token"));
    assert!(!result.to_string().contains("uploaded transcript"));
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn health_lists_providers_without_credentials() {
    let mock = google_mock(StatusCode::OK, json!({})).await;
    let (status, body) = response(
        mock.app.clone(),
        Request::get("/api/health").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["providers"],
        json!([
            { "id": "google", "label": "Google Cloud STT V2", "model": "short" },
            { "id": "google-v1", "label": "Google V1 / ABNF", "model": "latest_short" }
        ])
    );
    assert!(!body.to_string().contains("radio-lab"));
}

const ABNF: &str = "#ABNF 1.0 UTF-8;\nlanguage en-US;\nmode voice;\nroot $command;\npublic $command = tango;\n";

#[derive(Debug)]
struct MockV1Credentials;

impl google_cloud_auth::credentials::CredentialsProvider for MockV1Credentials {
    async fn headers(
        &self,
        _: axum::http::Extensions,
    ) -> Result<
        google_cloud_auth::credentials::CacheableResource<axum::http::HeaderMap>,
        google_cloud_auth::errors::CredentialsError,
    > {
        use google_cloud_auth::credentials::{CacheableResource, EntityTag};
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", "Bearer mock-adc".parse().unwrap());
        headers.insert("x-goog-user-project", "adc-quota-project".parse().unwrap());
        Ok(CacheableResource::New {
            entity_tag: EntityTag::new(),
            data: headers,
        })
    }

    async fn universe_domain(&self) -> Option<String> {
        None
    }
}

async fn google_v1_mock(status: StatusCode, body: serde_json::Value) -> GoogleMock {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let upstream = Router::new().route(
        "/v1/speech:recognize",
        post(
            move |headers: axum::http::HeaderMap, Json(request): Json<serde_json::Value>| {
                let captured = captured.clone();
                let body = body.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer mock-adc");
                    assert_eq!(headers["x-goog-user-project"], "radio-lab");
                    assert_eq!(headers.get_all("x-goog-user-project").iter().count(), 1);
                    captured.lock().unwrap().push(request);
                    (status, Json(body))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/speech:recognize", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = AppState::new(String::new(), "gpt-transcribe".into())
        .unwrap()
        .with_google(Some(config::GoogleConfig {
            project_id: "radio-lab".into(),
            ..Default::default()
        }));
    let v1 = state.google_v1.as_mut().unwrap();
    v1.endpoint = endpoint;
    v1.credentials
        .set(google_cloud_auth::credentials::Credentials::from(MockV1Credentials))
        .unwrap();
    GoogleMock {
        task,
        requests,
        app: router(Arc::new(state)),
    }
}

#[tokio::test]
async fn v1_forwards_verbatim_abnf_audio_and_phrase_hints() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let mock = google_v1_mock(
        StatusCode::OK,
        json!({
            "results": [{ "alternatives": [{ "transcript": "tango JCX 01008.", "confidence": 0.8 }] }],
            "speechAdaptationInfo": { "adaptationTimeout": false }
        }),
    )
    .await;
    let (status, result) = response(
        mock.app.clone(),
        upload(
            &[
                ("provider", "google-v1"),
                ("abnf", ABNF),
                ("keywords[]", "tango"),
                ("boost", "10"),
                ("languages[]", "en-US"),
            ],
            Some(AUDIO),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["provider"], "google-v1");
    assert_eq!(result["model"], "latest_short");
    assert_eq!(result["text"], "tango JCX 01008.");
    assert_eq!(result["adaptation_info"]["adaptationTimeout"], false);
    assert_eq!(result["results"][0]["alternatives"][0]["confidence"], 0.8);
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(
        STANDARD.decode(request["audio"]["content"].as_str().unwrap()).unwrap(),
        AUDIO
    );
    assert_eq!(request["config"]["model"], "latest_short");
    assert_eq!(request["config"]["languageCode"], "en-US");
    assert_eq!(
        request["config"]["adaptation"]["abnfGrammar"]["abnfStrings"],
        json!([ABNF])
    );
    assert_eq!(
        request["config"]["adaptation"]["phraseSets"][0]["boost"].as_f64(),
        Some(10.0)
    );
    assert!(request["config"].get("encoding").is_none());
    assert!(request["config"].get("sampleRateHertz").is_none());
}

#[tokio::test]
async fn v1_baseline_has_no_adaptation_and_accepts_flac_empty_transcript() {
    let mock = google_v1_mock(StatusCode::OK, json!({})).await;
    let (status, result) = response(
        mock.app.clone(),
        upload(&[("provider", "google-v1")], Some(b"fLaC-test")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["text"], "");
    let requests = mock.requests.lock().unwrap();
    assert!(requests[0]["config"].get("adaptation").is_none());
}

#[tokio::test]
async fn abnf_and_v1_input_validation_prevents_incompatible_requests() {
    let mock = google_v1_mock(StatusCode::OK, json!({})).await;
    let oversized_grammar = "a".repeat(64 * 1024 + 1);
    for fields in [
        vec![("provider", "google-v1"), ("abnf", " ")],
        vec![("provider", "google-v1"), ("abnf", ABNF), ("abnf", ABNF)],
        vec![("provider", "google-v1"), ("abnf", oversized_grammar.as_str())],
        vec![("provider", "google"), ("abnf", ABNF)],
        vec![("provider", "google-v1"), ("prompt", "unsupported")],
        vec![
            ("provider", "google-v1"),
            ("languages[]", "en-US"),
            ("languages[]", "ja-JP"),
        ],
    ] {
        let (status, result) = response(mock.app.clone(), upload(&fields, Some(AUDIO))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    }
    let (status, _) = response(mock.app.clone(), upload(&[("provider", "google-v1")], Some(b"ID3mp3"))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = response(
        mock.app.clone(),
        upload(&[("provider", "google-v1")], Some(&vec![0; 10_000_001])),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(mock.requests.lock().unwrap().is_empty());
    let openai = self::mock(StatusCode::OK, json!({ "text": "unused" })).await;
    let (status, _) = response(openai.app.clone(), upload(&[("abnf", ABNF)], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(openai.fields.lock().unwrap().is_empty());
}

#[tokio::test]
async fn v1_upstream_failures_are_redacted_without_retry_and_malformed_results_are_rejected() {
    let mock = google_v1_mock(
        StatusCode::BAD_REQUEST,
        json!({ "error": { "message": "secret-token grammar" } }),
    )
    .await;
    let (status, result) = response(
        mock.app.clone(),
        upload(&[("provider", "google-v1"), ("abnf", ABNF)], Some(AUDIO)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(result["upstream_status"], 400);
    assert!(result["error"].as_str().unwrap().contains("grammar"));
    assert!(!result.to_string().contains("secret-token"));
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
    let mock = google_v1_mock(
        StatusCode::OK,
        json!({ "results": [{ "alternatives": [{ "transcript": 123 }] }] }),
    )
    .await;
    let (status, result) = response(mock.app.clone(), upload(&[("provider", "google-v1")], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(result["error"], "invalid Google V1 transcription response");
}
