//! Users. Internally identified by a UUID (also the WebAuthn user handle); shown as their callsign.

use serde::Serialize;
use uuid::Uuid;

use crate::{
    db::{self, Db},
    error::{Error, Result},
    qso::is_callsign,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct User {
    pub id: Uuid,
    pub callsign: String,
    pub default_station_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    callsign: String,
    default_station_id: Option<String>,
}

impl TryFrom<Row> for User {
    type Error = Error;

    fn try_from(row: Row) -> Result<Self> {
        Ok(User {
            id: Uuid::parse_str(&row.id).map_err(|e| Error::Internal(format!("bad user id {:?}: {e}", row.id)))?,
            callsign: row.callsign,
            default_station_id: row.default_station_id,
        })
    }
}

const COLUMNS: &str = "id, callsign, default_station_id";

/// Upper-cases a callsign and checks it.
pub fn normalize_callsign(callsign: &str) -> Result<String> {
    let callsign = callsign.trim().to_uppercase();
    if !is_callsign(&callsign) {
        return Err(Error::Unprocessable(format!("{callsign:?} is not a valid callsign")));
    }
    Ok(callsign)
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.is_unique_violation())
}

pub async fn create(db: &Db, callsign: &str) -> Result<User> {
    let callsign = normalize_callsign(callsign)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, callsign, created_at) VALUES (?, ?, ?)")
        .bind(id.to_string())
        .bind(&callsign)
        .bind(db::now())
        .execute(db)
        .await
        .map_err(|e| match e {
            e if is_unique_violation(&e) => Error::Conflict(format!("{callsign} already exists")),
            e => e.into(),
        })?;
    Ok(User {
        id,
        callsign,
        default_station_id: None,
    })
}

pub async fn find(db: &Db, id: Uuid) -> Result<Option<User>> {
    sqlx::query_as::<_, Row>(&format!("SELECT {COLUMNS} FROM users WHERE id = ?"))
        .bind(id.to_string())
        .fetch_optional(db)
        .await?
        .map(User::try_from)
        .transpose()
}

pub async fn find_by_callsign(db: &Db, callsign: &str) -> Result<Option<User>> {
    sqlx::query_as::<_, Row>(&format!("SELECT {COLUMNS} FROM users WHERE callsign = ?"))
        .bind(callsign.trim().to_uppercase())
        .fetch_optional(db)
        .await?
        .map(User::try_from)
        .transpose()
}

/// Like [`find_by_callsign`], but a missing user is an error.
pub async fn get_by_callsign(db: &Db, callsign: &str) -> Result<User> {
    find_by_callsign(db, callsign)
        .await?
        .ok_or_else(|| Error::NotFound(format!("no user {}", callsign.trim().to_uppercase())))
}

pub async fn list(db: &Db) -> Result<Vec<User>> {
    sqlx::query_as::<_, Row>(&format!("SELECT {COLUMNS} FROM users ORDER BY callsign"))
        .fetch_all(db)
        .await?
        .into_iter()
        .map(User::try_from)
        .collect()
}

pub async fn rename(db: &Db, callsign: &str, new_callsign: &str) -> Result<User> {
    let user = get_by_callsign(db, callsign).await?;
    let new_callsign = normalize_callsign(new_callsign)?;
    sqlx::query("UPDATE users SET callsign = ? WHERE id = ?")
        .bind(&new_callsign)
        .bind(user.id.to_string())
        .execute(db)
        .await
        .map_err(|e| match e {
            e if is_unique_violation(&e) => Error::Conflict(format!("{new_callsign} already exists")),
            e => e.into(),
        })?;
    Ok(User {
        callsign: new_callsign,
        ..user
    })
}

/// Deletes a user together with their passkeys, sessions, stations and QSOs.
pub async fn delete(db: &Db, callsign: &str) -> Result<User> {
    let user = get_by_callsign(db, callsign).await?;
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(user.id.to_string())
        .execute(db)
        .await?;
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_finds_renames_and_deletes() {
        let db = db::open_in_memory().await.unwrap();
        let user = create(&db, " jj1abc ").await.unwrap();
        assert_eq!(user.callsign, "JJ1ABC");
        assert_eq!(find(&db, user.id).await.unwrap(), Some(user.clone()));
        assert_eq!(find_by_callsign(&db, "jj1abc").await.unwrap(), Some(user.clone()));

        assert!(matches!(create(&db, "JJ1ABC").await, Err(Error::Conflict(_))));
        assert!(matches!(create(&db, "nope").await, Err(Error::Unprocessable(_))));

        let other = create(&db, "JL1HIS").await.unwrap();
        assert!(matches!(rename(&db, "JJ1ABC", "jl1his").await, Err(Error::Conflict(_))));
        let renamed = rename(&db, "JJ1ABC", "JJ1ABC/1").await.unwrap();
        assert_eq!(renamed.id, user.id);
        assert_eq!(list(&db).await.unwrap(), [renamed, other.clone()]);

        delete(&db, "JJ1ABC/1").await.unwrap();
        assert_eq!(list(&db).await.unwrap(), [other]);
        assert!(matches!(delete(&db, "JJ1ABC/1").await, Err(Error::NotFound(_))));
    }
}
