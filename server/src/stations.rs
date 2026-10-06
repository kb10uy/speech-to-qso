//! Station locations: copies of the user's Wavelog station locations, or ones entered by hand.
//!
//! A station provides the defaults of an operating session (callsign, location, POTA reference
//! and so on). Which station a device uses is chosen on the device; the server keeps the
//! user's default.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    db::{self, Db},
    error::{Error, Result},
    users::normalize_callsign,
    wavelog::WavelogStation,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Station {
    pub id: String,
    /// The Wavelog station location id; `None` for stations entered by hand.
    pub wavelog_id: Option<i64>,
    pub name: String,
    pub callsign: String,
    pub gridsquare: String,
    pub city: String,
    pub state: String,
    pub cnty: String,
    pub pota: String,
    pub sota: String,
    pub wwff: String,
    pub iota: String,
    pub sig: String,
    pub sig_info: String,
    pub power: Option<i64>,
    pub active: bool,
}

/// A station entered by hand.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct StationInput {
    pub name: String,
    pub callsign: String,
    pub gridsquare: String,
    pub city: String,
    pub state: String,
    pub cnty: String,
    pub pota: String,
    pub sota: String,
    pub wwff: String,
    pub iota: String,
    pub sig: String,
    pub sig_info: String,
    pub power: Option<i64>,
}

impl StationInput {
    fn normalize(self) -> Result<Self> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return Err(Error::Unprocessable("name: must not be empty".into()));
        }
        if self.power.is_some_and(|p| p < 0) {
            return Err(Error::Unprocessable("power: must not be negative".into()));
        }
        let upper = |s: String| s.trim().to_uppercase();
        Ok(Self {
            name,
            callsign: normalize_callsign(&self.callsign)?,
            gridsquare: upper(self.gridsquare),
            city: self.city.trim().into(),
            state: self.state.trim().into(),
            cnty: self.cnty.trim().into(),
            pota: upper(self.pota),
            sota: upper(self.sota),
            wwff: upper(self.wwff),
            iota: upper(self.iota),
            sig: upper(self.sig),
            sig_info: upper(self.sig_info),
            power: self.power,
        })
    }
}

impl From<WavelogStation> for StationInput {
    fn from(s: WavelogStation) -> Self {
        Self {
            name: s.name,
            callsign: s.callsign,
            gridsquare: s.gridsquare,
            city: s.city,
            state: s.state,
            cnty: s.cnty,
            pota: s.pota,
            sota: s.sota,
            wwff: s.wwff,
            iota: s.iota,
            sig: s.sig,
            sig_info: s.sig_info,
            power: s.power,
        }
    }
}

/// The stations of a user and the one used when a device has not chosen any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StationList {
    pub default_station_id: Option<String>,
    pub stations: Vec<Station>,
}

const COLUMNS: &str = "id, wavelog_id, name, callsign, gridsquare, city, state, cnty, pota, sota, wwff, iota, \
                       sig, sig_info, power, active";

pub async fn list(db: &Db, user_id: Uuid) -> Result<StationList> {
    let stations = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM stations WHERE user_id = ? ORDER BY wavelog_id IS NULL, wavelog_id, name, id"
    ))
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    let default_station_id = sqlx::query_scalar("SELECT default_station_id FROM users WHERE id = ?")
        .bind(user_id.to_string())
        .fetch_one(db)
        .await?;
    Ok(StationList {
        default_station_id,
        stations,
    })
}

pub async fn find(db: &Db, user_id: Uuid, id: &str) -> Result<Option<Station>> {
    Ok(
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM stations WHERE user_id = ? AND id = ?"))
            .bind(user_id.to_string())
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// The station a QSO was logged with: the one it names, or else the user's default.
pub async fn resolve(db: &Db, user_id: Uuid, id: Option<&str>) -> Result<Option<Station>> {
    match id {
        Some(id) => find(db, user_id, id)
            .await?
            .map(Some)
            .ok_or_else(|| Error::Unprocessable(format!("station_id: no station {id:?}"))),
        None => {
            let default: Option<String> = sqlx::query_scalar("SELECT default_station_id FROM users WHERE id = ?")
                .bind(user_id.to_string())
                .fetch_one(db)
                .await?;
            match default {
                Some(id) => find(db, user_id, &id).await,
                None => Ok(None),
            }
        }
    }
}

pub async fn set_default(db: &Db, user_id: Uuid, id: Option<&str>) -> Result<()> {
    if let Some(id) = id
        && find(db, user_id, id).await?.is_none()
    {
        return Err(Error::NotFound(format!("no station {id:?}")));
    }
    sqlx::query("UPDATE users SET default_station_id = ? WHERE id = ?")
        .bind(id)
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    Ok(())
}

pub async fn create(db: &Db, user_id: Uuid, input: StationInput) -> Result<Station> {
    let input = input.normalize()?;
    let id = Uuid::new_v4().to_string();
    write(db, user_id, &id, None, &input, false).await?;
    let station = find(db, user_id, &id)
        .await?
        .ok_or_else(|| Error::Internal("lost a station".into()))?;
    sqlx::query("UPDATE users SET default_station_id = ? WHERE id = ? AND default_station_id IS NULL")
        .bind(&station.id)
        .bind(user_id.to_string())
        .execute(db)
        .await?;
    Ok(station)
}

/// Replaces a station entered by hand. Wavelog stations are edited in Wavelog.
pub async fn update(db: &Db, user_id: Uuid, id: &str, input: StationInput) -> Result<Station> {
    let input = input.normalize()?;
    let station = editable(db, user_id, id).await?;
    write(db, user_id, &station.id, None, &input, false).await?;
    find(db, user_id, id)
        .await?
        .ok_or_else(|| Error::Internal("lost a station".into()))
}

pub async fn delete(db: &Db, user_id: Uuid, id: &str) -> Result<()> {
    editable(db, user_id, id).await?;
    sqlx::query("DELETE FROM stations WHERE user_id = ? AND id = ?")
        .bind(user_id.to_string())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

async fn editable(db: &Db, user_id: Uuid, id: &str) -> Result<Station> {
    let station = find(db, user_id, id)
        .await?
        .ok_or_else(|| Error::NotFound(format!("no station {id:?}")))?;
    if station.wavelog_id.is_some() {
        return Err(Error::Conflict("Wavelog stations are edited in Wavelog".into()));
    }
    Ok(station)
}

async fn write<'e, E: sqlx::SqliteExecutor<'e>>(
    executor: E,
    user_id: Uuid,
    id: &str,
    wavelog_id: Option<i64>,
    s: &StationInput,
    active: bool,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO stations (id, user_id, wavelog_id, name, callsign, gridsquare, city, state, cnty, pota, sota, \
         wwff, iota, sig, sig_info, power, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \
         ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, callsign = excluded.callsign, gridsquare = \
         excluded.gridsquare, city = excluded.city, state = excluded.state, cnty = excluded.cnty, pota = \
         excluded.pota, sota = excluded.sota, wwff = excluded.wwff, iota = excluded.iota, sig = excluded.sig, \
         sig_info = excluded.sig_info, power = excluded.power, active = excluded.active, updated_at = \
         excluded.updated_at",
    )
    .bind(id)
    .bind(user_id.to_string())
    .bind(wavelog_id)
    .bind(&s.name)
    .bind(&s.callsign)
    .bind(&s.gridsquare)
    .bind(&s.city)
    .bind(&s.state)
    .bind(&s.cnty)
    .bind(&s.pota)
    .bind(&s.sota)
    .bind(&s.wwff)
    .bind(&s.iota)
    .bind(&s.sig)
    .bind(&s.sig_info)
    .bind(s.power)
    .bind(active)
    .bind(db::now())
    .execute(executor)
    .await?;
    Ok(())
}

/// Replaces the user's copies of their Wavelog stations with `fetched`. Station ids stay stable
/// across refreshes, so devices keep their selection. If the user has no default station yet,
/// the active Wavelog station becomes the default.
pub async fn replace_wavelog_stations(db: &Db, user_id: Uuid, fetched: Vec<WavelogStation>) -> Result<StationList> {
    let mut tx = db.begin().await?;
    let existing: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, wavelog_id FROM stations WHERE user_id = ? AND wavelog_id IS NOT NULL")
            .bind(user_id.to_string())
            .fetch_all(&mut *tx)
            .await?;

    let mut active_id = None;
    for station in &fetched {
        let id = existing
            .iter()
            .find(|(_, wavelog_id)| *wavelog_id == station.id)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if station.active {
            active_id = Some(id.clone());
        }
        let wavelog_id = station.id;
        let active = station.active;
        let input = StationInput::from(station.clone());
        // Wavelog validated these already; only make the callsign comparable.
        let input = StationInput {
            callsign: input.callsign.trim().to_uppercase(),
            ..input
        };
        write(&mut *tx, user_id, &id, Some(wavelog_id), &input, active).await?;
    }
    for (id, wavelog_id) in &existing {
        if !fetched.iter().any(|s| s.id == *wavelog_id) {
            sqlx::query("DELETE FROM stations WHERE id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(active_id) = active_id {
        sqlx::query("UPDATE users SET default_station_id = ? WHERE id = ? AND default_station_id IS NULL")
            .bind(active_id)
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    list(db, user_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::users;

    fn wavelog_station(id: i64, name: &str, active: bool) -> WavelogStation {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "callsign": "jj1abc", "city": "Minato", "pota": "JP-0001", "active": active
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn mirrors_wavelog_stations_with_stable_ids() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();

        let list = replace_wavelog_stations(
            &db,
            user.id,
            vec![wavelog_station(1, "Home", false), wavelog_station(2, "Park", true)],
        )
        .await
        .unwrap();
        assert_eq!(list.stations.len(), 2);
        assert_eq!(list.stations[0].callsign, "JJ1ABC");
        let park = list.stations[1].clone();
        assert_eq!(list.default_station_id.as_ref(), Some(&park.id));

        let list = replace_wavelog_stations(
            &db,
            user.id,
            vec![wavelog_station(2, "Park 2", false), wavelog_station(3, "Hill", true)],
        )
        .await
        .unwrap();
        assert_eq!(
            list.stations.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["Park 2", "Hill"]
        );
        assert_eq!(list.stations[0].id, park.id);
        // The default is the user's choice once set.
        assert_eq!(list.default_station_id.as_ref(), Some(&park.id));

        let list = replace_wavelog_stations(&db, user.id, vec![]).await.unwrap();
        assert!(list.stations.is_empty());
        assert_eq!(list.default_station_id, None);
    }

    #[tokio::test]
    async fn manages_stations_entered_by_hand() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let other = users::create(&db, "JL1HIS").await.unwrap();

        let input = StationInput {
            name: " Park ".into(),
            callsign: "jj1abc/1".into(),
            pota: "jp-0001".into(),
            ..Default::default()
        };
        let station = create(&db, user.id, input.clone()).await.unwrap();
        assert_eq!((station.name.as_str(), station.callsign.as_str()), ("Park", "JJ1ABC/1"));
        assert_eq!(station.pota, "JP-0001");
        assert_eq!(
            list(&db, user.id).await.unwrap().default_station_id,
            Some(station.id.clone())
        );

        assert_eq!(resolve(&db, user.id, None).await.unwrap(), Some(station.clone()));
        assert!(matches!(
            resolve(&db, other.id, Some(&station.id)).await,
            Err(Error::Unprocessable(_))
        ));

        let renamed = StationInput {
            name: "Hill".into(),
            ..input.clone()
        };
        assert_eq!(update(&db, user.id, &station.id, renamed).await.unwrap().name, "Hill");
        assert!(matches!(
            update(&db, user.id, &station.id, StationInput::default()).await,
            Err(Error::Unprocessable(_))
        ));
        assert!(matches!(
            delete(&db, other.id, &station.id).await,
            Err(Error::NotFound(_))
        ));

        delete(&db, user.id, &station.id).await.unwrap();
        let list = list(&db, user.id).await.unwrap();
        assert!(list.stations.is_empty());
        assert_eq!(list.default_station_id, None);
    }

    #[tokio::test]
    async fn wavelog_stations_are_read_only() {
        let db = db::open_in_memory().await.unwrap();
        let user = users::create(&db, "JJ1ABC").await.unwrap();
        let list = replace_wavelog_stations(&db, user.id, vec![wavelog_station(1, "Home", true)])
            .await
            .unwrap();
        let id = &list.stations[0].id;
        assert!(matches!(delete(&db, user.id, id).await, Err(Error::Conflict(_))));
        set_default(&db, user.id, None).await.unwrap();
        assert!(matches!(
            set_default(&db, user.id, Some("nope")).await,
            Err(Error::NotFound(_))
        ));
    }
}
