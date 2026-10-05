//! Passkey sign-in and registration, sessions.
//!
//! There are no passwords. The first passkey of a user is registered through a one-time link
//! issued by `passkey bootstrap` on the server; later ones are added from a signed-in session.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{FromRequestParts, Path, State},
    http::{StatusCode, request::Parts},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
use webauthn_rs::prelude::{
    CreationChallengeResponse, DiscoverableAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, WebauthnError,
};

use super::AppState;
use crate::{
    error::{Error, Result},
    passkeys::{self, PasskeyInfo},
    sessions::{self, SESSION_TTL},
    users::{self, User},
};

pub const SESSION_COOKIE: &str = "__Host-session";

/// How long a browser has to answer a WebAuthn challenge.
const CEREMONY_TTL: Duration = Duration::from_secs(300);

/// Caps the unauthenticated memory use of `POST /api/auth/login/start`.
const MAX_CEREMONIES: usize = 1000;

pub enum Ceremony {
    Registration {
        user_id: Uuid,
        state: PasskeyRegistration,
        /// Set when registering the first passkey through a bootstrap link.
        bootstrap_token: Option<String>,
    },
    Authentication(DiscoverableAuthentication),
}

/// WebAuthn challenges in flight. They live only in memory: a restart just means trying again.
#[derive(Default)]
pub struct Ceremonies(Mutex<HashMap<String, (Instant, Ceremony)>>);

impl Ceremonies {
    pub fn start(&self, ceremony: Ceremony) -> Result<String> {
        let mut map = self.0.lock().expect("ceremony lock poisoned");
        map.retain(|_, (started, _)| started.elapsed() < CEREMONY_TTL);
        if map.len() >= MAX_CEREMONIES {
            return Err(Error::TooManyRequests(
                "too many sign-in attempts; try again later".into(),
            ));
        }
        let id = sessions::random_token();
        map.insert(id.clone(), (Instant::now(), ceremony));
        Ok(id)
    }

    pub fn finish(&self, id: &str) -> Result<Ceremony> {
        let (started, ceremony) = self
            .0
            .lock()
            .expect("ceremony lock poisoned")
            .remove(id)
            .ok_or_else(expired)?;
        if started.elapsed() >= CEREMONY_TTL {
            return Err(expired());
        }
        Ok(ceremony)
    }
}

fn expired() -> Error {
    Error::BadRequest("the passkey request expired; try again".into())
}

fn webauthn_failed(e: WebauthnError) -> Error {
    Error::Internal(format!("WebAuthn: {e}"))
}

fn session_cookie(token: String) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::seconds(SESSION_TTL.num_seconds()))
        .build()
}

/// The signed-in user. Rejects the request with 401 without a valid session.
pub struct CurrentUser(pub User);

impl FromRequestParts<Arc<AppState>> for CurrentUser {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(SESSION_COOKIE).ok_or(Error::Unauthorized)?.value();
        sessions::authenticate(&state.db, token)
            .await?
            .map(CurrentUser)
            .ok_or(Error::Unauthorized)
    }
}

#[derive(Debug, Serialize)]
pub struct Me {
    pub id: Uuid,
    pub callsign: String,
}

impl From<User> for Me {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            callsign: user.callsign,
        }
    }
}

/// The signed-in user. Also renews the cookie, whose lifetime follows the session's.
pub async fn me(CurrentUser(user): CurrentUser, jar: CookieJar) -> (CookieJar, Json<Me>) {
    let token = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .unwrap_or_default();
    (jar.add(session_cookie(token)), Json(user.into()))
}

pub async fn logout(State(state): State<Arc<AppState>>, jar: CookieJar) -> Result<(CookieJar, StatusCode)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        sessions::delete(&state.db, cookie.value()).await?;
    }
    Ok((jar.remove(session_cookie(String::new())), StatusCode::NO_CONTENT))
}

/// Starts a sign-in with any passkey of this site (a discoverable credential), so the user does
/// not have to type their callsign.
pub async fn login_start(State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    let (challenge, auth) = state
        .webauthn
        .start_discoverable_authentication()
        .map_err(webauthn_failed)?;
    let ceremony = state.ceremonies.start(Ceremony::Authentication(auth))?;
    let mut options = serde_json::to_value(challenge).map_err(|e| Error::Internal(e.to_string()))?;
    // webauthn-rs asks for conditional mediation (autofill); the app signs in from a button.
    if let Some(options) = options.as_object_mut() {
        options.remove("mediation");
    }
    Ok(Json(json!({ "ceremony": ceremony, "options": options })))
}

#[derive(Deserialize)]
pub struct LoginFinish {
    ceremony: String,
    credential: PublicKeyCredential,
}

pub async fn login_finish(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(req): Json<LoginFinish>,
) -> Result<(CookieJar, Json<Me>)> {
    let Ceremony::Authentication(auth) = state.ceremonies.finish(&req.ceremony)? else {
        return Err(expired());
    };
    let unknown = || Error::Forbidden("this passkey is not registered here (it may have been deleted)".into());
    let (user_id, credential_id) = state
        .webauthn
        .identify_discoverable_authentication(&req.credential)
        .map_err(|_| unknown())?;
    let mut stored = passkeys::find_by_credential_id(&state.db, credential_id)
        .await?
        .filter(|p| p.user_id == user_id)
        .ok_or_else(unknown)?;
    let result = state
        .webauthn
        .finish_discoverable_authentication(&req.credential, auth, &[(&stored.passkey).into()])
        .map_err(|e| {
            tracing::info!("passkey sign-in failed: {e}");
            Error::Forbidden(format!("passkey sign-in failed: {e}"))
        })?;
    stored.passkey.update_credential(&result);
    passkeys::record_use(&state.db, &stored).await?;

    let user = users::find(&state.db, user_id).await?.ok_or_else(unknown)?;
    let token = sessions::create(&state.db, user.id).await?;
    tracing::info!("{} signed in", user.callsign);
    Ok((jar.add(session_cookie(token)), Json(user.into())))
}

/// Registration options that ask for a discoverable credential, which sign-in relies on.
/// webauthn-rs only "discourages" them; passkey providers create them either way.
fn require_resident_key(challenge: CreationChallengeResponse) -> Result<Value> {
    let mut options = serde_json::to_value(challenge).map_err(|e| Error::Internal(e.to_string()))?;
    let selection = options
        .pointer_mut("/publicKey/authenticatorSelection")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| Error::Internal("registration options without authenticatorSelection".into()))?;
    selection.insert("residentKey".into(), "required".into());
    selection.insert("requireResidentKey".into(), true.into());
    Ok(options)
}

/// The user a bootstrap link is for, as long as they have no passkey yet.
async fn bootstrap_user(state: &AppState, token: &str) -> Result<User> {
    let user = sessions::bootstrap_user(&state.db, token)
        .await?
        .ok_or_else(|| Error::Forbidden("this setup link is invalid or has expired; ask for a new one".into()))?;
    if passkeys::count(&state.db, user.id).await? > 0 {
        return Err(Error::Forbidden(format!(
            "{} already has a passkey; sign in instead",
            user.callsign
        )));
    }
    Ok(user)
}

#[derive(Deserialize)]
pub struct BootstrapStart {
    token: String,
}

pub async fn bootstrap_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BootstrapStart>,
) -> Result<Json<Value>> {
    let user = bootstrap_user(&state, &req.token).await?;
    let (challenge, registration) = state
        .webauthn
        .start_passkey_registration(user.id, &user.callsign, &user.callsign, None)
        .map_err(webauthn_failed)?;
    let ceremony = state.ceremonies.start(Ceremony::Registration {
        user_id: user.id,
        state: registration,
        bootstrap_token: Some(req.token),
    })?;
    Ok(Json(json!({
        "ceremony": ceremony,
        "options": require_resident_key(challenge)?,
        "callsign": user.callsign,
    })))
}

#[derive(Deserialize)]
pub struct RegisterFinish {
    ceremony: String,
    credential: RegisterPublicKeyCredential,
    #[serde(default)]
    name: String,
}

fn registration_failed(e: WebauthnError) -> Error {
    Error::BadRequest(format!("passkey registration failed: {e}"))
}

pub async fn bootstrap_finish(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(req): Json<RegisterFinish>,
) -> Result<(CookieJar, Json<Me>)> {
    let Ceremony::Registration {
        user_id,
        state: registration,
        bootstrap_token: Some(token),
    } = state.ceremonies.finish(&req.ceremony)?
    else {
        return Err(expired());
    };
    // Checked again: the link may have been used or revoked in the meantime.
    let user = bootstrap_user(&state, &token).await?;
    if user.id != user_id {
        return Err(expired());
    }
    let passkey = state
        .webauthn
        .finish_passkey_registration(&req.credential, &registration)
        .map_err(registration_failed)?;
    passkeys::insert(&state.db, user.id, &passkey, &req.name).await?;
    sessions::delete_bootstrap_tokens(&state.db, user.id).await?;

    let token = sessions::create(&state.db, user.id).await?;
    tracing::info!("{} registered their first passkey", user.callsign);
    Ok((jar.add(session_cookie(token)), Json(user.into())))
}

pub async fn list_passkeys(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<PasskeyInfo>>> {
    Ok(Json(passkeys::list(&state.db, user.id).await?))
}

pub async fn passkey_registration_start(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>> {
    let exclude = passkeys::credentials(&state.db, user.id)
        .await?
        .iter()
        .map(|p| p.cred_id().clone())
        .collect();
    let (challenge, registration) = state
        .webauthn
        .start_passkey_registration(user.id, &user.callsign, &user.callsign, Some(exclude))
        .map_err(webauthn_failed)?;
    let ceremony = state.ceremonies.start(Ceremony::Registration {
        user_id: user.id,
        state: registration,
        bootstrap_token: None,
    })?;
    Ok(Json(
        json!({ "ceremony": ceremony, "options": require_resident_key(challenge)? }),
    ))
}

pub async fn passkey_registration_finish(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<RegisterFinish>,
) -> Result<(StatusCode, Json<PasskeyInfo>)> {
    let Ceremony::Registration {
        user_id,
        state: registration,
        bootstrap_token: None,
    } = state.ceremonies.finish(&req.ceremony)?
    else {
        return Err(expired());
    };
    if user_id != user.id {
        return Err(expired());
    }
    let passkey = state
        .webauthn
        .finish_passkey_registration(&req.credential, &registration)
        .map_err(registration_failed)?;
    let info = passkeys::insert(&state.db, user.id, &passkey, &req.name).await?;
    tracing::info!("{} added a passkey", user.callsign);
    Ok((StatusCode::CREATED, Json(info)))
}

#[derive(Deserialize)]
pub struct RenamePasskey {
    name: String,
}

pub async fn rename_passkey(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<RenamePasskey>,
) -> Result<StatusCode> {
    passkeys::rename(&state.db, user.id, &id, &req.name).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_passkey(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    passkeys::delete(&state.db, user.id, &id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceremonies_are_used_once() {
        let ceremonies = Ceremonies::default();
        let webauthn = super::super::tests::webauthn();
        let (_, auth) = webauthn.start_discoverable_authentication().unwrap();
        let id = ceremonies.start(Ceremony::Authentication(auth)).unwrap();
        assert!(matches!(ceremonies.finish(&id), Ok(Ceremony::Authentication(_))));
        assert!(matches!(ceremonies.finish(&id), Err(Error::BadRequest(_))));
        assert!(matches!(ceremonies.finish("unknown"), Err(Error::BadRequest(_))));
    }

    #[test]
    fn registration_asks_for_a_discoverable_credential() {
        let webauthn = super::super::tests::webauthn();
        let (challenge, _) = webauthn
            .start_passkey_registration(Uuid::new_v4(), "JJ1ABC", "JJ1ABC", None)
            .unwrap();
        let options = require_resident_key(challenge).unwrap();
        let selection = &options["publicKey"]["authenticatorSelection"];
        assert_eq!(selection["residentKey"], "required");
        assert_eq!(selection["requireResidentKey"], true);
        assert_eq!(options["publicKey"]["user"]["name"], "JJ1ABC");
    }
}
