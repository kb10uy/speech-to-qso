//! Registered passkeys. A user can have several (one per device or password manager).

use serde::Serialize;
use uuid::Uuid;
use webauthn_rs::prelude::Passkey;

use crate::{
    db::{self, Db},
    error::{Error, Result},
};

/// What the passkey list shows; the credential itself never leaves the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct PasskeyInfo {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

pub struct StoredPasskey {
    pub id: String,
    pub user_id: Uuid,
    pub passkey: Passkey,
}

/// Trims a user-given passkey name; an empty one gets a default.
pub fn normalize_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "Passkey".into()
    } else {
        name.chars().take(64).collect()
    }
}

fn decode(json: &str) -> Result<Passkey> {
    serde_json::from_str(json).map_err(|e| Error::Internal(format!("bad stored passkey: {e}")))
}

fn encode(passkey: &Passkey) -> Result<String> {
    serde_json::to_string(passkey).map_err(|e| Error::Internal(format!("cannot store passkey: {e}")))
}

pub async fn count(db: &Db, user_id: Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE user_id = ?")
        .bind(user_id.to_string())
        .fetch_one(db)
        .await?)
}

pub async fn list(db: &Db, user_id: Uuid) -> Result<Vec<PasskeyInfo>> {
    Ok(sqlx::query_as(
        "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at, id",
    )
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?)
}

/// The credentials of a user, so that an authenticator does not register the same one twice.
pub async fn credentials(db: &Db, user_id: Uuid) -> Result<Vec<Passkey>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT passkey FROM passkeys WHERE user_id = ?")
        .bind(user_id.to_string())
        .fetch_all(db)
        .await?;
    rows.iter().map(|json| decode(json)).collect()
}

pub async fn insert(db: &Db, user_id: Uuid, passkey: &Passkey, name: &str) -> Result<PasskeyInfo> {
    let info = PasskeyInfo {
        id: Uuid::new_v4().to_string(),
        name: normalize_name(name),
        created_at: db::now(),
        last_used_at: None,
    };
    sqlx::query(
        "INSERT INTO passkeys (id, user_id, credential_id, passkey, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&info.id)
    .bind(user_id.to_string())
    .bind(AsRef::<[u8]>::as_ref(passkey.cred_id()))
    .bind(encode(passkey)?)
    .bind(&info.name)
    .bind(&info.created_at)
    .execute(db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            Error::Conflict("this passkey is already registered".into())
        }
        e => e.into(),
    })?;
    Ok(info)
}

pub async fn find_by_credential_id(db: &Db, credential_id: &[u8]) -> Result<Option<StoredPasskey>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT id, user_id, passkey FROM passkeys WHERE credential_id = ?")
            .bind(credential_id)
            .fetch_optional(db)
            .await?;
    row.map(|(id, user_id, json)| {
        Ok(StoredPasskey {
            id,
            user_id: Uuid::parse_str(&user_id).map_err(|e| Error::Internal(format!("bad user id: {e}")))?,
            passkey: decode(&json)?,
        })
    })
    .transpose()
}

/// Saves the credential after a sign-in (its counter may have changed) and when it was used.
pub async fn record_use(db: &Db, stored: &StoredPasskey) -> Result<()> {
    sqlx::query("UPDATE passkeys SET passkey = ?, last_used_at = ? WHERE id = ?")
        .bind(encode(&stored.passkey)?)
        .bind(db::now())
        .bind(&stored.id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn rename(db: &Db, user_id: Uuid, id: &str, name: &str) -> Result<()> {
    let result = sqlx::query("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?")
        .bind(normalize_name(name))
        .bind(id)
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(Error::NotFound("no such passkey".into()));
    }
    Ok(())
}

/// Deletes one passkey. The last one is kept unless `allow_last` is set, so that a user cannot
/// lock themselves out from the web UI; the admin command can still remove it.
pub async fn delete(db: &Db, user_id: Uuid, id: &str, allow_last: bool) -> Result<()> {
    let mut tx = db.begin().await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE user_id = ?")
        .bind(user_id.to_string())
        .fetch_one(&mut *tx)
        .await?;
    let result = sqlx::query("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(Error::NotFound("no such passkey".into()));
    }
    if count == 1 && !allow_last {
        return Err(Error::Conflict("the last passkey cannot be deleted".into()));
    }
    tx.commit().await?;
    Ok(())
}

pub async fn delete_all(db: &Db, user_id: Uuid) -> Result<u64> {
    let result = sqlx::query("DELETE FROM passkeys WHERE user_id = ?")
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_names() {
        assert_eq!(normalize_name("  "), "Passkey");
        assert_eq!(normalize_name(" iPhone "), "iPhone");
        assert_eq!(normalize_name(&"x".repeat(100)).len(), 64);
    }

    #[tokio::test]
    async fn rename_and_delete_only_touch_the_owners_passkeys() {
        let db = db::open_in_memory().await.unwrap();
        let user = crate::users::create(&db, "JJ1ABC").await.unwrap();
        let other = crate::users::create(&db, "JL1HIS").await.unwrap();
        for (id, credential) in [("a", b"cred-a"), ("b", b"cred-b")] {
            sqlx::query(
                "INSERT INTO passkeys (id, user_id, credential_id, passkey, name, created_at) \
                 VALUES (?, ?, ?, '{}', 'Passkey', ?)",
            )
            .bind(id)
            .bind(user.id.to_string())
            .bind(credential.as_slice())
            .bind(db::now())
            .execute(&db)
            .await
            .unwrap();
        }

        assert!(matches!(rename(&db, other.id, "a", "x").await, Err(Error::NotFound(_))));
        rename(&db, user.id, "a", " Phone ").await.unwrap();
        assert_eq!(list(&db, user.id).await.unwrap()[0].name, "Phone");

        assert!(matches!(
            delete(&db, other.id, "a", false).await,
            Err(Error::NotFound(_))
        ));
        delete(&db, user.id, "a", false).await.unwrap();
        assert!(matches!(
            delete(&db, user.id, "b", false).await,
            Err(Error::Conflict(_))
        ));
        assert_eq!(count(&db, user.id).await.unwrap(), 1);
        delete(&db, user.id, "b", true).await.unwrap();
        assert_eq!(count(&db, user.id).await.unwrap(), 0);
    }
}
