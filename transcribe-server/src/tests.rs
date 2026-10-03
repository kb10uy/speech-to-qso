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
    content_type: Option<String>,
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
                    let content_type = field.content_type().map(str::to_owned);
                    let bytes = field.bytes().await.unwrap().to_vec();
                    captured.lock().unwrap().push(UploadedField {
                        name,
                        filename,
                        content_type,
                        bytes,
                    });
                }
                (status, Json(response))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut state = AppState::new("test-key".into(), "gpt-transcribe".into()).unwrap();
    state.endpoint = endpoint;
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
    assert_eq!(file.content_type.as_deref(), Some("audio/wav"));
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
    assert!(!result.to_string().contains("test-key"));
}

#[tokio::test]
async fn malformed_upstream_response_is_a_gateway_error() {
    let mock = mock(StatusCode::OK, json!({ "wrong_field": "text" })).await;
    let (status, result) = response(mock.app.clone(), upload(&[], Some(AUDIO))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(result["error"], "invalid OpenAI transcription response");
}
