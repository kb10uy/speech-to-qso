//! The QSO payload sent by the web client (`POST /api/qso`).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

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
    #[serde(default)]
    pub qsl_requested: bool,
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

fn is_callsign(s: &str) -> bool {
    (3..=16).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '/')
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
            "qsl_requested": true,
            "time_on": "2026-10-03T04:05:06.789Z",
            "operator": "JJ1ABC",
            "location": "Minato",
            "pota_ref": "JA-0001"
        }))
        .unwrap()
    }

    #[test]
    fn accepts_a_valid_payload() {
        assert_eq!(sample().validate(), Ok(()));
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
        assert!(!qso.qsl_requested);
        assert_eq!(qso.location, "");
    }

    #[test]
    fn rejects_invalid_fields() {
        type Mutation = Box<dyn Fn(&mut QsoPayload)>;
        let cases: Vec<(&str, Mutation)> = vec![
            ("id", Box::new(|q| q.id.clear())),
            ("call", Box::new(|q| q.call = "jl1his".into())),
            ("call", Box::new(|q| q.call = "<EOR>".into())),
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
