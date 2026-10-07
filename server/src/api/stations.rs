//! Wavelog connection, station locations, and what Wavelog knows about a callsign.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use super::{AppState, auth::CurrentUser};
use crate::{
    error::{Error, Result},
    qso::is_callsign,
    stations::{self, Station, StationInput, StationList},
    wavelog::{self, CallsignHistory, WavelogConnection, WavelogError},
};

fn wavelog_failed(e: WavelogError) -> Error {
    Error::BadGateway(e.to_string())
}

/// Accepts what people copy from the address bar, e.g. `https://log.example.com/index.php/dashboard`.
fn normalize_wavelog_url(url: &str) -> Result<String> {
    let invalid = || Error::Unprocessable(format!("url: {url:?} is not an http(s) URL"));
    let mut parsed = url::Url::parse(url.trim()).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(invalid());
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let path = parsed.path().to_string();
    let base = path.split("/index.php").next().unwrap_or("").trim_end_matches('/');
    parsed.set_path(base);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

#[derive(Serialize)]
pub struct WavelogSettings {
    configured: bool,
    url: Option<String>,
}

pub async fn get_wavelog(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<WavelogSettings>> {
    let conn = wavelog::load_connection(&state.db, user.id).await?;
    Ok(Json(WavelogSettings {
        configured: conn.is_some(),
        url: conn.map(|c| c.url),
    }))
}

#[derive(Deserialize)]
pub struct PutWavelog {
    url: String,
    /// Keeps the stored token when missing, so the URL can be fixed without re-entering it.
    #[serde(default)]
    token: Option<String>,
}

/// Saves the Wavelog connection after checking it by fetching the station locations.
pub async fn put_wavelog(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<PutWavelog>,
) -> Result<Json<StationList>> {
    let url = normalize_wavelog_url(&req.url)?;
    let token = match req.token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(token) => token,
        None => wavelog::load_connection(&state.db, user.id)
            .await?
            .map(|c| c.token)
            .ok_or_else(|| Error::Unprocessable("token: required".into()))?,
    };
    let conn = WavelogConnection { url, token };
    let fetched = state.wavelog.stations(&conn).await.map_err(wavelog_failed)?;
    wavelog::save_connection(&state.db, user.id, &conn).await?;
    Ok(Json(
        stations::replace_wavelog_stations(&state.db, user.id, fetched).await?,
    ))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    callsign: String,
}

#[derive(Serialize)]
pub struct HistoryResponse {
    callsign: String,
    #[serde(flatten)]
    history: CallsignHistory,
}

/// The user's past QSOs with a callsign, as Wavelog has them.
pub async fn get_history(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryResponse>> {
    let callsign = query.callsign.trim().to_uppercase();
    if !is_callsign(&callsign) {
        return Err(Error::Unprocessable(format!(
            "callsign: {callsign:?} is not a valid callsign"
        )));
    }
    let conn = wavelog::load_connection(&state.db, user.id)
        .await?
        .ok_or_else(|| Error::Conflict("Wavelog is not set up".into()))?;
    let history = state
        .wavelog
        .callsign_history(&conn, &callsign)
        .await
        .map_err(wavelog_failed)?;
    Ok(Json(HistoryResponse { callsign, history }))
}

/// Forgets the Wavelog connection. The copied stations stay, but QSOs are no longer forwarded.
pub async fn delete_wavelog(State(state): State<Arc<AppState>>, CurrentUser(user): CurrentUser) -> Result<StatusCode> {
    wavelog::delete_connection(&state.db, user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_stations(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<StationList>> {
    Ok(Json(stations::list(&state.db, user.id).await?))
}

pub async fn refresh_stations(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<StationList>> {
    let conn = wavelog::load_connection(&state.db, user.id)
        .await?
        .ok_or_else(|| Error::Conflict("Wavelog is not set up".into()))?;
    let fetched = state.wavelog.stations(&conn).await.map_err(wavelog_failed)?;
    Ok(Json(
        stations::replace_wavelog_stations(&state.db, user.id, fetched).await?,
    ))
}

#[derive(Deserialize)]
pub struct DefaultStation {
    station_id: Option<String>,
}

pub async fn set_default_station(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<DefaultStation>,
) -> Result<StatusCode> {
    stations::set_default(&state.db, user.id, req.station_id.as_deref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_station(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(input): Json<StationInput>,
) -> Result<(StatusCode, Json<Station>)> {
    Ok((
        StatusCode::CREATED,
        Json(stations::create(&state.db, user.id, input).await?),
    ))
}

pub async fn update_station(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(input): Json<StationInput>,
) -> Result<Json<Station>> {
    Ok(Json(stations::update(&state.db, user.id, &id, input).await?))
}

pub async fn delete_station(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    stations::delete(&state.db, user.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_wavelog_urls() {
        for (given, expected) in [
            ("https://log.example.com", "https://log.example.com"),
            ("https://log.example.com/", "https://log.example.com"),
            (
                "https://log.example.com/index.php/dashboard?x=1",
                "https://log.example.com",
            ),
            ("https://example.com/wavelog/index.php", "https://example.com/wavelog"),
            ("http://192.168.1.2:8086/", "http://192.168.1.2:8086"),
        ] {
            assert_eq!(normalize_wavelog_url(given).unwrap(), expected, "{given}");
        }
        assert!(normalize_wavelog_url("log.example.com").is_err());
        assert!(normalize_wavelog_url("ftp://log.example.com").is_err());
    }
}
