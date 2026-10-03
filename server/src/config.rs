//! Configuration from environment variables.

use std::{net::SocketAddr, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WavelogConfig {
    /// Base URL of the Wavelog installation, e.g. `https://log.example.com`.
    pub url: String,
    pub api_key: String,
    /// Station location used when the client does not specify one.
    pub default_station_profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub listen: SocketAddr,
    /// Bearer token required from clients. `None` disables authentication (local testing only).
    pub api_token: Option<String>,
    /// Origins allowed by CORS. Empty allows any origin (requests are still token-protected).
    pub allowed_origins: Vec<String>,
    /// Directory for the append-only QSO log (`qsos.jsonl`) and ADIF log (`log.adi`).
    pub data_dir: PathBuf,
    pub wavelog: Option<WavelogConfig>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|key| std::env::var(key).ok())
    }

    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let get = |key: &str| var(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());

        let listen = get("LISTEN")
            .unwrap_or_else(|| "127.0.0.1:8080".into())
            .parse()
            .map_err(|e| format!("LISTEN: {e}"))?;

        let allowed_origins = get("ALLOWED_ORIGINS")
            .map(|v| {
                v.split(',')
                    .map(|o| o.trim().trim_end_matches('/').to_string())
                    .filter(|o| !o.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let wavelog = match (get("WAVELOG_URL"), get("WAVELOG_API_KEY")) {
            (Some(url), Some(api_key)) => Some(WavelogConfig {
                url: url.trim_end_matches('/').to_string(),
                api_key,
                default_station_profile_id: get("WAVELOG_STATION_ID"),
            }),
            (None, None) => None,
            _ => return Err("WAVELOG_URL and WAVELOG_API_KEY must be set together".into()),
        };

        Ok(Self {
            listen,
            api_token: get("API_TOKEN"),
            allowed_origins,
            data_dir: get("DATA_DIR").unwrap_or_else(|| "data".into()).into(),
            wavelog,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<_, _> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_vars(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults() {
        let c = config(&[]).unwrap();
        assert_eq!(c.listen, "127.0.0.1:8080".parse().unwrap());
        assert_eq!(c.api_token, None);
        assert!(c.allowed_origins.is_empty());
        assert_eq!(c.data_dir, PathBuf::from("data"));
        assert_eq!(c.wavelog, None);
    }

    #[test]
    fn parses_everything() {
        let c = config(&[
            ("LISTEN", "0.0.0.0:3000"),
            ("API_TOKEN", "secret"),
            ("ALLOWED_ORIGINS", "https://kb10uy.github.io/, http://localhost:5173"),
            ("DATA_DIR", "/var/lib/qso"),
            ("WAVELOG_URL", "https://log.example.com/"),
            ("WAVELOG_API_KEY", "key"),
            ("WAVELOG_STATION_ID", "2"),
        ])
        .unwrap();
        assert_eq!(c.api_token.as_deref(), Some("secret"));
        assert_eq!(c.allowed_origins, ["https://kb10uy.github.io", "http://localhost:5173"]);
        assert_eq!(
            c.wavelog,
            Some(WavelogConfig {
                url: "https://log.example.com".into(),
                api_key: "key".into(),
                default_station_profile_id: Some("2".into()),
            })
        );
    }

    #[test]
    fn rejects_partial_wavelog_config() {
        assert!(config(&[("WAVELOG_URL", "https://x")]).is_err());
        assert!(config(&[("LISTEN", "nope")]).is_err());
    }
}
