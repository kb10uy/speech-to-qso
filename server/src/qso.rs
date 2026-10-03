//! The QSO payload sent by the web client (`POST /api/qso`).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

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
    pub time_on: DateTime<Utc>,
    pub operator: String,
    #[serde(default)]
    pub location: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pota_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_jcx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station_profile_id: Option<String>,
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
fn is_callsign(s: &str) -> bool {
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

impl QsoPayload {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.id.is_empty() || self.id.len() > 64 {
            return Err(invalid("id", "must be 1-64 characters"));
        }
        if !is_callsign(&self.call) {
            return Err(invalid("call", format!("{:?} is not a valid callsign", self.call)));
        }
        if !is_callsign(&self.operator) {
            return Err(invalid(
                "operator",
                format!("{:?} is not a valid callsign", self.operator),
            ));
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
        if let Some(jcx) = &self.jcx
            && !jcx.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Err(invalid("jcx", "must be alphanumeric"));
        }
        Ok(())
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
            "rst_sent": "599", "rst_rcvd": "579", "time_on": "2026-10-03T04:05:06Z",
            "operator": "JJ1ABC"
        }))
        .unwrap();
        assert_eq!(qso.validate(), Ok(()));
        assert_eq!(qso.qsl, Qsl::None);
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
    fn rejects_invalid_fields() {
        type Mutation = Box<dyn Fn(&mut QsoPayload)>;
        let cases: Vec<(&str, Mutation)> = vec![
            ("id", Box::new(|q| q.id.clear())),
            ("call", Box::new(|q| q.call = "jl1his".into())),
            ("call", Box::new(|q| q.call = "<EOR>".into())),
            ("call", Box::new(|q| q.call = "JL1HIS/".into())),
            ("call", Box::new(|q| q.call = "JL1//P".into())),
            ("operator", Box::new(|q| q.operator = "".into())),
            ("frequency", Box::new(|q| q.frequency = 0)),
            ("mode", Box::new(|q| q.mode = "F M".into())),
            ("rst_sent", Box::new(|q| q.rst_sent = "69".into())),
            ("rst_rcvd", Box::new(|q| q.rst_rcvd = "5".into())),
            ("jcx", Box::new(|q| q.jcx = Some("10 01".into()))),
        ];
        for (field, mutate) in cases {
            let mut qso = sample();
            mutate(&mut qso);
            assert_eq!(qso.validate().unwrap_err().field, field);
        }
    }
}
