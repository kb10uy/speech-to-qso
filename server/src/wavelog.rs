//! Wavelog API client (`POST /index.php/api/qso`).

use serde::Serialize;

use crate::config::WavelogConfig;

#[derive(Debug, thiserror::Error)]
pub enum WavelogError {
    #[error("no Wavelog station location configured (set WAVELOG_STATION_ID or send station_profile_id)")]
    NoStation,
    #[error("request to Wavelog failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("Wavelog rejected the QSO (HTTP {status}): {body}")]
    Rejected { status: u16, body: String },
}

#[derive(Serialize)]
struct QsoRequest<'a> {
    key: &'a str,
    station_profile_id: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    string: &'a str,
}

#[derive(Debug, Clone)]
pub struct WavelogClient {
    http: reqwest::Client,
    config: WavelogConfig,
}

impl WavelogClient {
    pub fn new(config: WavelogConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent(concat!("speech-to-qso-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client");
        Self { http, config }
    }

    /// Uploads one ADIF record.
    pub async fn upload(&self, adif_record: &str, station_profile_id: Option<&str>) -> Result<(), WavelogError> {
        let station = station_profile_id
            .or(self.config.default_station_profile_id.as_deref())
            .ok_or(WavelogError::NoStation)?;
        let response = self
            .http
            .post(format!("{}/index.php/api/qso", self.config.url))
            .json(&QsoRequest {
                key: &self.config.api_key,
                station_profile_id: station,
                kind: "adif",
                string: adif_record,
            })
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        // Wavelog answers 201 with {"status":"created"} on success, and {"status":"failed"} otherwise.
        let failed = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(|s| s == "failed"))
            .unwrap_or(false);
        if !status.is_success() || failed {
            return Err(WavelogError::Rejected {
                status: status.as_u16(),
                body: body.chars().take(500).collect(),
            });
        }
        Ok(())
    }
}
