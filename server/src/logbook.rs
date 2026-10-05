//! The QSOs each user has logged, and whether they have been forwarded to Wavelog.

use uuid::Uuid;

use crate::{
    db::{self, Db},
    error::{Error, Result},
    qso::QsoPayload,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// Whether the QSO has been uploaded to Wavelog.
    pub forwarded: bool,
}

/// Stores a QSO unless one with the same client id exists. Returns the existing entry, if any.
pub async fn insert(db: &Db, user_id: Uuid, qso: &QsoPayload) -> Result<Option<Entry>> {
    let payload = serde_json::to_string(qso).map_err(|e| Error::Internal(e.to_string()))?;
    let result =
        sqlx::query("INSERT INTO qsos (user_id, id, payload, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
            .bind(user_id.to_string())
            .bind(&qso.id)
            .bind(payload)
            .bind(db::now())
            .execute(db)
            .await?;
    if result.rows_affected() == 1 {
        return Ok(None);
    }
    get(db, user_id, &qso.id).await
}

pub async fn get(db: &Db, user_id: Uuid, id: &str) -> Result<Option<Entry>> {
    let forwarded: Option<bool> =
        sqlx::query_scalar("SELECT forwarded_at IS NOT NULL FROM qsos WHERE user_id = ? AND id = ?")
            .bind(user_id.to_string())
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(forwarded.map(|forwarded| Entry { forwarded }))
}

pub async fn record_forwarded(db: &Db, user_id: Uuid, id: &str, wavelog_qso_id: Option<i64>) -> Result<()> {
    sqlx::query(
        "UPDATE qsos SET forwarded_at = ?, wavelog_qso_id = ?, forward_error = NULL WHERE user_id = ? AND id = ?",
    )
    .bind(db::now())
    .bind(wavelog_qso_id)
    .bind(user_id.to_string())
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn record_forward_error(db: &Db, user_id: Uuid, id: &str, error: &str) -> Result<()> {
    sqlx::query("UPDATE qsos SET forward_error = ? WHERE user_id = ? AND id = ?")
        .bind(error)
        .bind(user_id.to_string())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// All QSOs of a user in the order they were logged.
pub async fn list(db: &Db, user_id: Uuid) -> Result<Vec<QsoPayload>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT payload FROM qsos WHERE user_id = ? ORDER BY received_at, id")
        .bind(user_id.to_string())
        .fetch_all(db)
        .await?;
    rows.iter()
        .map(|json| serde_json::from_str(json).map_err(|e| Error::Internal(format!("bad stored QSO: {e}"))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{qso::tests::sample, users};

    #[tokio::test]
    async fn deduplicates_per_user() {
        let db = db::open_in_memory().await.unwrap();
        let a = users::create(&db, "JJ1ABC").await.unwrap();
        let b = users::create(&db, "JL1HIS").await.unwrap();
        let qso = sample();

        assert_eq!(insert(&db, a.id, &qso).await.unwrap(), None);
        assert_eq!(insert(&db, a.id, &qso).await.unwrap(), Some(Entry { forwarded: false }));
        // Client ids are only unique per user.
        assert_eq!(insert(&db, b.id, &qso).await.unwrap(), None);

        record_forward_error(&db, a.id, &qso.id, "nope").await.unwrap();
        record_forwarded(&db, a.id, &qso.id, Some(42)).await.unwrap();
        assert_eq!(get(&db, a.id, &qso.id).await.unwrap(), Some(Entry { forwarded: true }));
        assert_eq!(get(&db, b.id, &qso.id).await.unwrap(), Some(Entry { forwarded: false }));
        assert_eq!(list(&db, a.id).await.unwrap(), [qso]);
    }
}
