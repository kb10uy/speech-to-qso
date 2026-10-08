//! The QSO payload sent by the web client (`POST /api/qso`).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::band::band_for_frequency;

/// QSL card arrangement for a QSO. Mirrors `QslStatus` in `web/src/lib/dsl/parser.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Qsl {
    #[default]
    None,
    /// The other station asked for our card.
    Requested,
    /// The other station sends a card and expects none back.
    OneWay,
}

/// Also reads the boolean `qsl_requested` that clients sent (and the local log stored) before
/// `qsl` existed.
fn deserialize_qsl<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Qsl, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Wire {
        Status(Qsl),
        Legacy(bool),
    }
    Ok(match Wire::deserialize(deserializer)? {
        Wire::Status(qsl) => qsl,
        Wire::Legacy(true) => Qsl::Requested,
        Wire::Legacy(false) => Qsl::None,
    })
}

/// Mirrors `QsoApiPayload` in `web/src/lib/qso/record.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QsoPayload {
    /// Client-generated UUID, used for idempotent retries.
    pub id: String,
    pub call: String,
    /// Frequency in Hz.
    pub frequency: u64,
    pub mode: String,
    pub rst_sent: String,
    pub rst_rcvd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jcx: Option<String>,
    #[serde(default, alias = "qsl_requested", deserialize_with = "deserialize_qsl")]
    pub qsl: Qsl,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qth: Option<String>,
    pub time_on: DateTime<Utc>,
    /// Missing when the user leaves it to Wavelog, which fills in the token owner's callsign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(default)]
    pub location: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pota_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_jcx: Option<String>,
    /// Callsign of the station location, when it differs from the operator's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station_callsign: Option<String>,
    /// The user's station (`stations.id`). The user's default station is used when it is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station_id: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{field}: {message}")]
pub struct ValidationError {
    pub field: &'static str,
    pub message: String,
}

fn invalid(field: &'static str, message: impl Into<String>) -> ValidationError {
    ValidationError {
        field,
        message: message.into(),
    }
}

/// Same rule as `isCallsign` in `web/src/lib/dsl/parser.ts`.
pub fn is_callsign(s: &str) -> bool {
    (3..=16).contains(&s.len())
        && s.split('/')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_uppercase())
}

fn is_rst(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() == 2 || b.len() == 3) && (b'1'..=b'5').contains(&b[0]) && b[1..].iter().all(|d| (b'1'..=b'9').contains(d))
}

const FREE_TEXT_MAX_LENGTH: usize = 100;

fn is_free_text(s: &str) -> bool {
    (1..=FREE_TEXT_MAX_LENGTH).contains(&s.chars().count()) && !s.chars().any(char::is_control)
}

impl QsoPayload {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.id.is_empty() || self.id.len() > 64 {
            return Err(invalid("id", "must be 1-64 characters"));
        }
        if !is_callsign(&self.call) {
            return Err(invalid("call", format!("{:?} is not a valid callsign", self.call)));
        }
        if let Some(operator) = &self.operator
            && !is_callsign(operator)
        {
            return Err(invalid("operator", format!("{operator:?} is not a valid callsign")));
        }
        if self.frequency == 0 {
            return Err(invalid("frequency", "must be positive"));
        }
        if self.mode.is_empty() || !self.mode.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(invalid("mode", "must be alphanumeric"));
        }
        if !is_rst(&self.rst_sent) {
            return Err(invalid("rst_sent", format!("{:?} is not a valid RST", self.rst_sent)));
        }
        if !is_rst(&self.rst_rcvd) {
            return Err(invalid("rst_rcvd", format!("{:?} is not a valid RST", self.rst_rcvd)));
        }
        if let Some(call) = &self.station_callsign
            && !is_callsign(call)
        {
            return Err(invalid("station_callsign", format!("{call:?} is not a valid callsign")));
        }
        if let Some(jcx) = &self.jcx
            && !jcx.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Err(invalid("jcx", "must be alphanumeric"));
        }
        for (field, text) in [("name", &self.name), ("qth", &self.qth)] {
            if let Some(text) = text
                && !is_free_text(text)
            {
                return Err(invalid(
                    field,
                    format!("must be 1-{FREE_TEXT_MAX_LENGTH} characters without control characters"),
                ));
            }
        }
        Ok(())
    }
}

impl QsoPayload {
    /// The body of `POST /api/v2/qso`. Mirrors the ADIF record, except that the station callsign
    /// comes from the station location and app-defined fields are left out.
    pub fn to_wavelog(&self, station_profile_id: i64) -> Result<Value, ValidationError> {
        let band = band_for_frequency(self.frequency)
            .ok_or_else(|| invalid("frequency", format!("{} Hz is not in an amateur band", self.frequency)))?;
        let mut body = Map::new();
        let mut set = |key: &str, value: Value| {
            body.insert(key.into(), value);
        };
        set("station_profile_id", station_profile_id.into());
        set("call", self.call.clone().into());
        set("band", band.into());
        set("mode", self.mode.clone().into());
        set("freq", self.frequency.into());
        set("qso_date", self.time_on.format("%Y-%m-%d").to_string().into());
        set("time_on", self.time_on.format("%H%M%S").to_string().into());
        set("rst_sent", self.rst_sent.clone().into());
        set("rst_rcvd", self.rst_rcvd.clone().into());
        match self.qsl {
            Qsl::None => {}
            Qsl::Requested => set("qsl_sent", "R".into()),
            Qsl::OneWay => {
                set("qsl_sent", "N".into());
                set("qsl_rcvd", "R".into());
            }
        }
        if let Some(jcx) = &self.jcx {
            set("cnty", jcx.clone().into());
        }
        if let Some(name) = &self.name {
            set("name", name.clone().into());
        }
        if let Some(qth) = &self.qth {
            set("qth", qth.clone().into());
        }
        if let Some(operator) = &self.operator {
            set("operator", operator.clone().into());
        }
        if !self.location.is_empty() {
            set("my_city", self.location.clone().into());
        }
        if let Some(my_jcx) = &self.my_jcx {
            set("my_cnty", my_jcx.clone().into());
        }
        if let Some(pota) = &self.pota_ref {
            set("my_sig", "POTA".into());
            set("my_sig_info", pota.clone().into());
            set("my_pota_ref", pota.clone().into());
        }
        Ok(Value::Object(body))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn sample() -> QsoPayload {
        serde_json::from_value(serde_json::json!({
            "id": "uuid-1",
            "call": "JL1HIS",
            "frequency": 432940000u64,
            "mode": "FM",
            "rst_sent": "59",
            "rst_rcvd": "57",
            "jcx": "100101",
            "qsl": "requested",
            "time_on": "2026-10-03T04:05:06.789Z",
            "operator": "JJ1ABC",
            "location": "Minato",
            "pota_ref": "JP-0001"
        }))
        .unwrap()
    }

    #[test]
    fn accepts_a_valid_payload() {
        assert_eq!(sample().validate(), Ok(()));
        for call in ["JL1HIS/1", "JL1HIS/P", "7K4XYZ", "JA1XYW/QRP"] {
            let mut qso = sample();
            qso.call = call.into();
            assert_eq!(qso.validate(), Ok(()), "{call}");
        }
    }

    #[test]
    fn optional_fields_default() {
        let qso: QsoPayload = serde_json::from_value(serde_json::json!({
            "id": "x", "call": "JL1HIS", "frequency": 7000000, "mode": "CW",
            "rst_sent": "599", "rst_rcvd": "579", "time_on": "2026-10-03T04:05:06Z"
        }))
        .unwrap();
        assert_eq!(qso.validate(), Ok(()));
        assert_eq!(qso.qsl, Qsl::None);
        assert_eq!(qso.operator, None);
        assert_eq!(qso.location, "");
    }

    #[test]
    fn reads_qsl_in_every_shape() {
        let qsl = |value: serde_json::Value| {
            let mut json = serde_json::to_value(sample()).unwrap();
            let key = if value.is_boolean() { "qsl_requested" } else { "qsl" };
            json.as_object_mut().unwrap().remove("qsl");
            json[key] = value;
            serde_json::from_value::<QsoPayload>(json).unwrap().qsl
        };
        assert_eq!(qsl(serde_json::json!("oneWay")), Qsl::OneWay);
        assert_eq!(qsl(serde_json::json!("none")), Qsl::None);
        // Lines written before `qsl` existed.
        assert_eq!(qsl(serde_json::json!(true)), Qsl::Requested);
        assert_eq!(qsl(serde_json::json!(false)), Qsl::None);
    }

    #[test]
    fn rejects_an_unknown_qsl() {
        let mut json = serde_json::to_value(sample()).unwrap();
        json["qsl"] = serde_json::json!("maybe");
        assert!(serde_json::from_value::<QsoPayload>(json).is_err());
    }

    #[test]
    fn builds_the_wavelog_request() {
        assert_eq!(
            sample().to_wavelog(3).unwrap(),
            serde_json::json!({
                "station_profile_id": 3,
                "call": "JL1HIS",
                "band": "70cm",
                "mode": "FM",
                "freq": 432940000u64,
                "qso_date": "2026-10-03",
                "time_on": "040506",
                "rst_sent": "59",
                "rst_rcvd": "57",
                "qsl_sent": "R",
                "cnty": "100101",
                "operator": "JJ1ABC",
                "my_city": "Minato",
                "my_sig": "POTA",
                "my_sig_info": "JP-0001",
                "my_pota_ref": "JP-0001"
            })
        );

        // Wavelog fills in the operator and the station location's values itself.
        let mut qso = sample();
        qso.operator = None;
        qso.location = String::new();
        qso.pota_ref = None;
        let body = qso.to_wavelog(3).unwrap();
        for key in ["operator", "my_city", "my_cnty", "my_sig", "my_sig_info", "my_pota_ref"] {
            assert!(body.get(key).is_none(), "{key}");
        }

        let mut qso = sample();
        qso.my_jcx = Some("100102".into());
        assert_eq!(qso.to_wavelog(3).unwrap()["my_cnty"], "100102");

        let mut qso = sample();
        qso.name = Some("太郎".into());
        qso.qth = Some("東京都港区".into());
        assert_eq!(qso.validate(), Ok(()));
        let body = qso.to_wavelog(3).unwrap();
        assert_eq!(body["name"], "太郎");
        assert_eq!(body["qth"], "東京都港区");

        let mut qso = sample();
        qso.frequency = 100_000_000;
        assert_eq!(qso.to_wavelog(3).unwrap_err().field, "frequency");
    }

    #[test]
    fn rejects_invalid_fields() {
        type Mutation = Box<dyn Fn(&mut QsoPayload)>;
        let cases: Vec<(&str, Mutation)> = vec![
            ("id", Box::new(|q| q.id.clear())),
            ("call", Box::new(|q| q.call = "jl1his".into())),
            ("call", Box::new(|q| q.call = "<EOR>".into())),
            ("call", Box::new(|q| q.call = "JL1HIS/".into())),
            ("call", Box::new(|q| q.call = "JL1//P".into())),
            ("operator", Box::new(|q| q.operator = Some("".into()))),
            ("frequency", Box::new(|q| q.frequency = 0)),
            ("mode", Box::new(|q| q.mode = "F M".into())),
            ("rst_sent", Box::new(|q| q.rst_sent = "69".into())),
            ("rst_rcvd", Box::new(|q| q.rst_rcvd = "5".into())),
            ("jcx", Box::new(|q| q.jcx = Some("10 01".into()))),
            ("name", Box::new(|q| q.name = Some("".into()))),
            ("name", Box::new(|q| q.name = Some("Taro\nYamada".into()))),
            ("qth", Box::new(|q| q.qth = Some("港".repeat(101)))),
            ("station_callsign", Box::new(|q| q.station_callsign = Some("x".into()))),
        ];
        for (field, mutate) in cases {
            let mut qso = sample();
            mutate(&mut qso);
            assert_eq!(qso.validate().unwrap_err().field, field);
        }
    }
}
