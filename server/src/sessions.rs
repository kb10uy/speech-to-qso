//! Login sessions and one-time passkey bootstrap tokens.
//!
//! Only SHA-256 hashes of the tokens are stored, so a leaked database cannot be used to sign in.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{TimeDelta, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    db::{self, Db},
    error::Result,
    users::{self, User},
};

/// Sessions are long-lived so that a portable operation is never interrupted by a login prompt.
pub const SESSION_TTL: TimeDelta = TimeDelta::days(60);

/// A session's expiry is pushed forward at most this often.
const SESSION_REFRESH: TimeDelta = TimeDelta::days(1);

/// A random 256-bit token, base64url-encoded.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Starts a session and returns its token.
pub async fn create(db: &Db, user_id: Uuid) -> Result<String> {
    sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(db::now())
        .execute(db)
        .await?;
    let token = random_token();
    let now = Utc::now();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(hash_token(&token))
        .bind(user_id.to_string())
        .bind(db::timestamp(now))
        .bind(db::timestamp(now + SESSION_TTL))
        .execute(db)
        .await?;
    Ok(token)
}

/// The user a session token belongs to. Using a session keeps it alive for another [`SESSION_TTL`].
pub async fn authenticate(db: &Db, token: &str) -> Result<Option<User>> {
    let hash = hash_token(token);
    let now = Utc::now();
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
            .bind(&hash)
            .bind(db::timestamp(now))
            .fetch_optional(db)
            .await?;
    let Some((user_id, expires_at)) = row else {
        return Ok(None);
    };
    if expires_at < db::timestamp(now + SESSION_TTL - SESSION_REFRESH) {
        sqlx::query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
            .bind(db::timestamp(now + SESSION_TTL))
            .bind(&hash)
            .execute(db)
            .await?;
    }
    let Ok(user_id) = Uuid::parse_str(&user_id) else {
        return Ok(None);
    };
    users::find(db, user_id).await
}

pub async fn delete(db: &Db, token: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(hash_token(token))
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_all(db: &Db, user_id: Uuid) -> Result<u64> {
    let result = sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    Ok(result.rows_affected())
}

/// Issues a one-time token that lets its holder register the first passkey of a user.
/// Earlier tokens of the user stop working.
pub async fn issue_bootstrap_token(db: &Db, user_id: Uuid, ttl: TimeDelta) -> Result<String> {
    let token = random_token();
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM bootstrap_tokens WHERE user_id = ? OR expires_at <= ?")
        .bind(user_id.to_string())
        .bind(db::now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO bootstrap_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(hash_token(&token))
        .bind(user_id.to_string())
        .bind(db::timestamp(Utc::now() + ttl))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(token)
}

/// The user an unexpired bootstrap token was issued for.
pub async fn bootstrap_user(db: &Db, token: &str) -> Result<Option<User>> {
    let user_id: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM bootstrap_tokens WHERE token_hash = ? AND expires_at > ?")
            .bind(hash_token(token))
            .bind(db::now())
            .fetch_optional(db)
            .await?;
    match user_id.and_then(|id| Uuid::parse_str(&id).ok()) {
        Some(id) => users::find(db, id).await,
        None => Ok(None),
    }
}

pub async fn delete_bootstrap_tokens(db: &Db, user_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM bootstrap_tokens WHERE user_id = ?")
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sessions_authenticate_until_deleted() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let token = create(&db, user.id).await.unwrap();
        assert_eq!(authenticate(&db, &token).await.unwrap(), Some(user.clone()));
        assert_eq!(authenticate(&db, "forged").await.unwrap(), None);

        let stored: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM sessions")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(stored, hash_token(&token));

        delete(&db, &token).await.unwrap();
        assert_eq!(authenticate(&db, &token).await.unwrap(), None);
    }

    #[tokio::test]
    async fn expired_sessions_do_not_authenticate_and_used_ones_are_extended() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let token = create(&db, user.id).await.unwrap();
        let set_expiry = |delta: TimeDelta| {
            sqlx::query("UPDATE sessions SET expires_at = ?").bind(db::timestamp(Utc::now() + delta))
        };

        set_expiry(TimeDelta::days(3)).execute(&db).await.unwrap();
        assert!(authenticate(&db, &token).await.unwrap().is_some());
        let expires_at: String = sqlx::query_scalar("SELECT expires_at FROM sessions")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(expires_at > db::timestamp(Utc::now() + SESSION_TTL - TimeDelta::hours(1)));

        set_expiry(TimeDelta::seconds(-1)).execute(&db).await.unwrap();
        assert_eq!(authenticate(&db, &token).await.unwrap(), None);
    }

    #[tokio::test]
    async fn bootstrap_tokens_replace_each_other_and_expire() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let first = issue_bootstrap_token(&db, user.id, TimeDelta::minutes(10))
            .await
            .unwrap();
        let second = issue_bootstrap_token(&db, user.id, TimeDelta::minutes(10))
            .await
            .unwrap();
        assert_eq!(bootstrap_user(&db, &first).await.unwrap(), None);
        assert_eq!(bootstrap_user(&db, &second).await.unwrap(), Some(user.clone()));

        let expired = issue_bootstrap_token(&db, user.id, TimeDelta::seconds(-1))
            .await
            .unwrap();
        assert_eq!(bootstrap_user(&db, &expired).await.unwrap(), None);

        let token = issue_bootstrap_token(&db, user.id, TimeDelta::minutes(10))
            .await
            .unwrap();
        delete_bootstrap_tokens(&db, user.id).await.unwrap();
        assert_eq!(bootstrap_user(&db, &token).await.unwrap(), None);
    }
}
