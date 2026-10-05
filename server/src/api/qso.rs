//! Logging QSOs and exporting the log.

use std::sync::Arc;

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

use super::{AppState, auth::CurrentUser};
use crate::{
    adif,
    error::{Error, Result},
    logbook,
    qso::QsoPayload,
    stations, wavelog,
};

/// Stores a QSO and forwards it to Wavelog when its station is a Wavelog station.
///
/// Retries are safe: QSOs are de-duplicated by their client id, and one that was stored but
/// not forwarded is forwarded again.
pub async fn post_qso(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    payload: std::result::Result<Json<QsoPayload>, JsonRejection>,
) -> Result<Response> {
    let Json(qso) = match payload {
        Ok(payload) => payload,
        Err(rejection) => {
            let body = Json(json!({ "status": "error", "error": rejection.body_text() }));
            return Ok((rejection.status(), body).into_response());
        }
    };
    qso.validate().map_err(|e| Error::Unprocessable(e.to_string()))?;

    let station = stations::resolve(&state.db, user.id, qso.station_id.as_deref()).await?;
    let connection = wavelog::load_connection(&state.db, user.id).await?;
    let target = match (connection, station.and_then(|s| s.wavelog_id)) {
        (Some(connection), Some(station_profile_id)) => {
            let body = qso
                .to_wavelog(station_profile_id)
                .map_err(|e| Error::Unprocessable(e.to_string()))?;
            Some((connection, body))
        }
        _ => None,
    };

    let _forwarding = state.forward_lock.lock().await;
    let existing = logbook::insert(&state.db, user.id, &qso).await?;
    let mut forwarded = existing.is_some_and(|e| e.forwarded);
    if let Some((connection, body)) = target
        && !forwarded
    {
        match state.wavelog.create_qso(&connection, &body).await {
            Ok(wavelog_id) => {
                logbook::record_forwarded(&state.db, user.id, &qso.id, wavelog_id).await?;
                forwarded = true;
            }
            Err(e) => {
                tracing::warn!("Wavelog upload of {} for {} failed: {e}", qso.id, user.callsign);
                logbook::record_forward_error(&state.db, user.id, &qso.id, &e.to_string()).await?;
                // Stored already; the client retries and only the upload is attempted again.
                return Err(Error::BadGateway(e.to_string()));
            }
        }
    }

    let (status, label) = match existing {
        None => (StatusCode::CREATED, "created"),
        Some(_) => (StatusCode::OK, "duplicate"),
    };
    tracing::info!("{} logged {} {} ({label})", user.callsign, qso.call, qso.id);
    Ok((
        status,
        Json(json!({ "status": label, "id": qso.id, "forwarded": forwarded })),
    )
        .into_response())
}

/// Every QSO of the user as an ADIF file.
pub async fn export_adif(State(state): State<Arc<AppState>>, CurrentUser(user): CurrentUser) -> Result<Response> {
    let mut text = adif::header();
    for qso in logbook::list(&state.db, user.id).await? {
        text.push_str(&adif::record(&qso));
        text.push('\n');
    }
    let filename = format!("{}.adi", user.callsign.replace('/', "_"));
    Ok((
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        text,
    )
        .into_response())
}
