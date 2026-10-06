//! Administration commands run on the server: users and their passkeys.

use chrono::TimeDelta;
use url::Url;

use crate::{
    db::Db,
    error::{Error, Result},
    passkeys, sessions, users,
};

/// Parses durations such as `90s`, `10m`, `2h` or `1d`.
pub fn parse_duration(s: &str) -> Result<TimeDelta, String> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (number, unit) = s.split_at(split);
    let n: i64 = number
        .parse()
        .map_err(|_| format!("{s:?} is not a duration such as 10m"))?;
    let delta = match unit {
        "s" => TimeDelta::try_seconds(n),
        "m" | "" => TimeDelta::try_minutes(n),
        "h" => TimeDelta::try_hours(n),
        "d" => TimeDelta::try_days(n),
        _ => None,
    };
    delta
        .filter(|d| *d > TimeDelta::zero())
        .ok_or_else(|| format!("{s:?} is not a duration such as 10m"))
}

/// Issues a one-time link that registers the first passkey of a user.
pub async fn bootstrap_link(db: &Db, public_origin: &Url, callsign: &str, ttl: TimeDelta) -> Result<String> {
    let user = users::get_by_callsign(db, callsign).await?;
    if passkeys::count(db, user.id).await? > 0 {
        return Err(Error::Conflict(format!(
            "{} already has passkeys; add more from the app, or revoke them all first",
            user.callsign
        )));
    }
    let token = sessions::issue_bootstrap_token(db, user.id, ttl).await?;
    // In the fragment, so the token never appears in request logs or Referer headers.
    let mut url = public_origin.clone();
    url.set_fragment(Some(&format!("bootstrap={token}")));
    Ok(url.into())
}

/// Revokes one passkey of a user (by id), or all of them. Revoking every passkey also ends the
/// user's sessions, so a lost device stops working; a new bootstrap link restores access.
pub async fn revoke_passkeys(db: &Db, callsign: &str, id: Option<&str>) -> Result<u64> {
    let user = users::get_by_callsign(db, callsign).await?;
    match id {
        Some(id) => {
            passkeys::delete(db, user.id, id, true).await?;
            if passkeys::count(db, user.id).await? == 0 {
                sessions::delete_all(db, user.id).await?;
            }
            Ok(1)
        }
        None => {
            let count = passkeys::delete_all(db, user.id).await?;
            sessions::delete_all(db, user.id).await?;
            Ok(count)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("90s"), Ok(TimeDelta::seconds(90)));
        assert_eq!(parse_duration("10m"), Ok(TimeDelta::minutes(10)));
        assert_eq!(parse_duration("10"), Ok(TimeDelta::minutes(10)));
        assert_eq!(parse_duration("2h"), Ok(TimeDelta::hours(2)));
        assert_eq!(parse_duration("1d"), Ok(TimeDelta::days(1)));
        for bad in ["", "m", "0m", "10y", "-1m"] {
            assert!(parse_duration(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn bootstrap_links_carry_the_token_in_the_fragment() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let origin = Url::parse("https://qso.example.com").unwrap();
        let link = bootstrap_link(&db, &origin, "jj1abc", TimeDelta::minutes(10))
            .await
            .unwrap();
        let token = link.strip_prefix("https://qso.example.com/#bootstrap=").unwrap();
        assert_eq!(sessions::bootstrap_user(&db, token).await.unwrap(), Some(user));
        assert!(matches!(
            bootstrap_link(&db, &origin, "JL1HIS", TimeDelta::minutes(10)).await,
            Err(Error::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn revoking_every_passkey_ends_sessions() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        sqlx::query(
            "INSERT INTO passkeys (id, user_id, credential_id, passkey, name, created_at) \
             VALUES ('p', ?, x'00', '{}', 'Passkey', '')",
        )
        .bind(user.id.to_string())
        .execute(&db)
        .await
        .unwrap();
        let session = sessions::create(&db, user.id).await.unwrap();
        let origin = Url::parse("https://qso.example.com").unwrap();
        assert!(matches!(
            bootstrap_link(&db, &origin, "JJ1ABC", TimeDelta::minutes(10)).await,
            Err(Error::Conflict(_))
        ));

        assert_eq!(revoke_passkeys(&db, "JJ1ABC", None).await.unwrap(), 1);
        assert_eq!(sessions::authenticate(&db, &session).await.unwrap(), None);
        assert!(
            bootstrap_link(&db, &origin, "JJ1ABC", TimeDelta::minutes(10))
                .await
                .is_ok()
        );
    }
}
