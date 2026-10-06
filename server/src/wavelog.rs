//! Wavelog API v2 client (Wavelog 3.1.0 or later).
//!
//! The token needs the `station:read`, `qso:read` and `qso:write` scopes.

use std::{collections::HashMap, time::Duration};

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    adif,
    db::{self, Db},
    error::Result,
};

/// The largest page `GET /api/v2/qso` returns.
const QSO_PAGE_SIZE: u32 = 5000;

#[derive(Debug, thiserror::Error)]
pub enum WavelogError {
    #[error("request to Wavelog failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("Wavelog rejected the API token (HTTP {status}): {message}")]
    Unauthorized { status: u16, message: String },
    #[error("Wavelog rejected the request (HTTP {status}): {message}")]
    Rejected { status: u16, message: String },
    #[error("unexpected response from Wavelog: {0}")]
    Unexpected(String),
}

/// Where a user's Wavelog is and how to talk to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WavelogConnection {
    /// Base URL of the Wavelog installation, e.g. `https://log.example.com`.
    pub url: String,
    pub token: String,
}

impl WavelogConnection {
    fn endpoint(&self, resource: &str) -> String {
        format!("{}/index.php/api/v2/{resource}", self.url.trim_end_matches('/'))
    }

    fn endpoint_with_query(&self, resource: &str, query: &[(&str, &str)]) -> Result<url::Url, WavelogError> {
        let mut url = url::Url::parse(&self.endpoint(resource))
            .map_err(|e| WavelogError::Unexpected(format!("invalid Wavelog URL: {e}")))?;
        url.query_pairs_mut().extend_pairs(query);
        Ok(url)
    }
}

fn string_or_null<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

fn lenient_bool<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<bool, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Bool(b) => b,
        Value::Number(n) => n.as_i64().is_some_and(|n| n != 0),
        Value::String(s) => matches!(s.as_str(), "1" | "true"),
        _ => false,
    })
}

fn lenient_integer<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<i64>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.round() as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    })
}

/// A station location (`GET /api/v2/station`). Only the fields this app uses.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WavelogStation {
    pub id: i64,
    #[serde(default, deserialize_with = "string_or_null")]
    pub name: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub callsign: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub gridsquare: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub city: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub state: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub cnty: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub pota: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub sota: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub wwff: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub iota: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub sig: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub sig_info: String,
    #[serde(default, deserialize_with = "lenient_integer")]
    pub power: Option<i64>,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub active: bool,
}

/// What the user's log says about a callsign.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CallsignHistory {
    pub qsos: u64,
    pub last_qso: Option<DateTime<Utc>>,
    /// When the latest QSO whose card was sent (`QSL_SENT` = Y) was made, not when it was sent.
    pub last_qsl_sent: Option<DateTime<Utc>>,
}

impl CallsignHistory {
    fn add(&mut self, record: &HashMap<String, String>) {
        let Some(time) = qso_time(record) else {
            return;
        };
        self.last_qso = self.last_qso.max(Some(time));
        if record.get("QSL_SENT").is_some_and(|s| s.eq_ignore_ascii_case("Y")) {
            self.last_qsl_sent = self.last_qsl_sent.max(Some(time));
        }
    }
}

fn qso_time(record: &HashMap<String, String>) -> Option<DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(record.get("QSO_DATE")?, "%Y%m%d").ok()?;
    let time = record.get("TIME_ON").map_or("0000", String::as_str);
    let time = NaiveTime::parse_from_str(time, "%H%M%S")
        .or_else(|_| NaiveTime::parse_from_str(time, "%H%M"))
        .ok()?;
    Some(date.and_time(time).and_utc())
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct Listing<T> {
    data: T,
    meta: ListMeta,
}

#[derive(Deserialize)]
struct ListMeta {
    total: u64,
    has_more: bool,
}

#[derive(Deserialize)]
struct AdifExport {
    adif: Option<String>,
}

#[derive(Deserialize)]
struct CreatedQso {
    id: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct WavelogClient {
    http: reqwest::Client,
}

impl Default for WavelogClient {
    fn default() -> Self {
        Self::new()
    }
}

impl WavelogClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("speech-to-qso-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client");
        Self { http }
    }

    async fn send<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        token: &str,
    ) -> std::result::Result<T, WavelogError> {
        self.fetch::<Envelope<T>>(request, token).await.map(|e| e.data)
    }

    /// Sends a request and reads the whole response body.
    async fn fetch<B: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        token: &str,
    ) -> std::result::Result<B, WavelogError> {
        let response = request.bearer_auth(token).send().await?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let message = error_message(&body);
            return Err(match status.as_u16() {
                401 | 403 => WavelogError::Unauthorized {
                    status: status.as_u16(),
                    message,
                },
                status => WavelogError::Rejected { status, message },
            });
        }
        serde_json::from_str::<B>(&body).map_err(|e| WavelogError::Unexpected(format!("{e}: {}", truncate(&body))))
    }

    /// Lists the station locations of the token's owner.
    pub async fn stations(&self, conn: &WavelogConnection) -> std::result::Result<Vec<WavelogStation>, WavelogError> {
        self.send(self.http.get(conn.endpoint("station")), &conn.token).await
    }

    /// Creates one QSO and returns its Wavelog id.
    pub async fn create_qso(
        &self,
        conn: &WavelogConnection,
        qso: &Value,
    ) -> std::result::Result<Option<i64>, WavelogError> {
        let created: CreatedQso = self
            .send(self.http.post(conn.endpoint("qso")).json(qso), &conn.token)
            .await?;
        Ok(created.id)
    }

    /// Counts the QSOs with a callsign (an exact match) and finds the latest ones.
    ///
    /// The JSON listing has no QSL fields, so the QSOs are read as ADIF.
    pub async fn callsign_history(
        &self,
        conn: &WavelogConnection,
        callsign: &str,
    ) -> std::result::Result<CallsignHistory, WavelogError> {
        let mut history = CallsignHistory::default();
        let per_page = QSO_PAGE_SIZE.to_string();
        for page in 1u32.. {
            let page = page.to_string();
            let url = conn.endpoint_with_query(
                "qso",
                &[
                    ("callsign", callsign),
                    ("format", "adif"),
                    ("per_page", &per_page),
                    ("page", &page),
                ],
            )?;
            let listing: Listing<AdifExport> = self.fetch(self.http.get(url), &conn.token).await?;
            history.qsos = listing.meta.total;
            for record in adif::read_records(listing.data.adif.as_deref().unwrap_or_default()) {
                history.add(&record);
            }
            if !listing.meta.has_more {
                break;
            }
        }
        Ok(history)
    }
}

/// The user's Wavelog, if they set one up. The token never leaves the server.
pub async fn load_connection(db: &Db, user_id: Uuid) -> Result<Option<WavelogConnection>> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT url, api_token FROM wavelog_settings WHERE user_id = ?")
        .bind(user_id.to_string())
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(url, token)| WavelogConnection { url, token }))
}

pub async fn save_connection(db: &Db, user_id: Uuid, conn: &WavelogConnection) -> Result<()> {
    sqlx::query(
        "INSERT INTO wavelog_settings (user_id, url, api_token, updated_at) VALUES (?, ?, ?, ?)          ON CONFLICT (user_id) DO UPDATE SET url = excluded.url, api_token = excluded.api_token,          updated_at = excluded.updated_at",
    )
    .bind(user_id.to_string())
    .bind(&conn.url)
    .bind(&conn.token)
    .bind(db::now())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete_connection(db: &Db, user_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM wavelog_settings WHERE user_id = ?")
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    Ok(())
}

fn truncate(s: &str) -> String {
    s.chars().take(300).collect()
}

/// Wavelog v2 answers errors with `{"error": {"code", "message", "details"}}`.
fn error_message(body: &str) -> String {
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return truncate(body);
    };
    let error = &json["error"];
    let mut message = [error["code"].as_str(), error["message"].as_str()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(": ");
    if let Some(details) = error.get("details").filter(|d| !d.is_null()) {
        message.push_str(&format!(" {details}"));
    }
    if message.is_empty() {
        truncate(body)
    } else {
        truncate(&message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_documented_station_object() {
        let station: WavelogStation = serde_json::from_value(serde_json::json!({
            "id": 1,
            "uuid": "c8904ea7-8bfa-11f1-865b-0241724b0b31",
            "name": "JO30oo / DJ7NT",
            "callsign": "DJ7NT",
            "gridsquare": "JO30OO",
            "city": "Bonn",
            "dxcc": 230,
            "country": "FEDERAL REPUBLIC OF GERMANY",
            "cq": 14,
            "itu": 28,
            "state": "",
            "cnty": "",
            "iota": "",
            "sota": "",
            "wwff": "",
            "pota": "",
            "sig": "",
            "sig_info": "",
            "power": 100,
            "active": true
        }))
        .unwrap();
        assert_eq!(station.id, 1);
        assert_eq!(station.callsign, "DJ7NT");
        assert_eq!(station.power, Some(100));
        assert!(station.active);
    }

    #[test]
    fn tolerates_nulls_and_loose_types() {
        let station: WavelogStation = serde_json::from_value(serde_json::json!({
            "id": 2, "name": "Home", "callsign": "JJ1ABC", "city": null, "power": "50", "active": "0"
        }))
        .unwrap();
        assert_eq!(station.city, "");
        assert_eq!(station.power, Some(50));
        assert!(!station.active);
    }

    #[test]
    fn keeps_the_latest_qso_and_the_latest_one_with_a_card_sent() {
        let mut history = CallsignHistory::default();
        let text = "<EOH>            <QSO_DATE:8>20250401 <TIME_ON:6>123456 <QSL_SENT:1>Y <QSLSDATE:8>20260101 <EOR>            <QSO_DATE:8>20240101 <TIME_ON:4>0910 <QSL_SENT:1>Y <EOR>            <QSO_DATE:8>20261003 <TIME_ON:6>040506 <QSL_SENT:1>R <EOR>            <QSO_DATE:8>2026 <EOR>";
        for record in adif::read_records(text) {
            history.add(&record);
        }
        let at = |s: &str| Some(s.parse::<DateTime<Utc>>().unwrap());
        assert_eq!(history.last_qso, at("2026-10-03T04:05:06Z"));
        assert_eq!(history.last_qsl_sent, at("2025-04-01T12:34:56Z"));
        assert_eq!(history.qsos, 0, "the count comes from Wavelog's total");
    }

    #[test]
    fn extracts_error_messages() {
        assert_eq!(
            error_message(r#"{"error":{"code":"validation_error","message":"band is required","details":null}}"#),
            "validation_error: band is required"
        );
        assert_eq!(error_message("Bad Gateway"), "Bad Gateway");
    }
}
