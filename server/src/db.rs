//! SQLite database.

use std::{path::Path, time::Duration};

use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

pub type Db = SqlitePool;

pub async fn open(path: &Path) -> Result<Db, sqlx::Error> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let db = SqlitePoolOptions::new().connect_with(options).await?;
    sqlx::migrate!().run(&db).await?;
    Ok(db)
}

/// A private in-memory database. A single connection, because each one would get its own database.
pub async fn open_in_memory() -> Result<Db, sqlx::Error> {
    let options = SqliteConnectOptions::new().in_memory(true).foreign_keys(true);
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&db).await?;
    Ok(db)
}

/// Timestamps are stored as fixed-width RFC 3339 text so that comparing strings compares times.
pub fn timestamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now() -> String {
    timestamp(Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_sort_as_text() {
        let a = timestamp("2026-10-05T12:00:00Z".parse().unwrap());
        let b = timestamp("2026-10-05T12:00:00.5Z".parse().unwrap());
        assert_eq!(a, "2026-10-05T12:00:00.000Z");
        assert!(a < b);
    }

    #[tokio::test]
    async fn opens_a_file_database_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("db.sqlite");
        open(&path).await.unwrap().close().await;
        open(&path).await.unwrap().close().await;
    }
}
