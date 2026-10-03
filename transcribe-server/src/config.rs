//! TOML configuration with environment overrides for local experiments and CI.

use std::{net::SocketAddr, path::Path};

use serde::Deserialize;

pub struct Config {
    pub listen: SocketAddr,
    pub api_key: String,
    pub model: String,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    listen: Option<String>,
    openai_api_key: Option<String>,
    model: Option<String>,
}

impl Config {
    pub fn load(path: &Path, required: bool) -> Result<Self, String> {
        let source = match std::fs::read_to_string(path) {
            Ok(source) => source,
            Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(format!("cannot read config {}: {error}", path.display())),
        };
        Self::from_sources(&source, |key| std::env::var(key).ok())
            .map_err(|error| format!("config {}: {error}", path.display()))
    }

    fn from_sources(source: &str, env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        // TOML diagnostics include source lines, so never print them from a file containing secrets.
        let file: FileConfig = toml::from_str(source)
            .map_err(|_| "invalid TOML; expected string fields: listen, model, openai_api_key".to_owned())?;
        let clean = |value: Option<String>| {
            value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let value = |key, fallback| clean(env(key)).or_else(|| clean(fallback));
        let api_key = value("OPENAI_API_KEY", file.openai_api_key)
            .ok_or("set openai_api_key in the TOML config or OPENAI_API_KEY in the environment")?;
        let listen = value("LISTEN", file.listen)
            .unwrap_or_else(|| "127.0.0.1:8081".into())
            .parse()
            .map_err(|_| "listen must be an IP address and port, e.g. 127.0.0.1:8081")?;
        let model = value("OPENAI_TRANSCRIBE_MODEL", file.model).unwrap_or_else(|| "gpt-transcribe".into());
        Ok(Self { listen, api_key, model })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_toml_settings() {
        let config = Config::from_sources(
            "listen = '127.0.0.1:9090'\nmodel = 'gpt-transcribe'\nopenai_api_key = 'test-key'",
            |_| None,
        )
        .unwrap();
        assert_eq!(config.listen, "127.0.0.1:9090".parse().unwrap());
        assert_eq!(config.api_key, "test-key");
        assert_eq!(config.model, "gpt-transcribe");
    }

    #[test]
    fn environment_overrides_file_and_empty_values_fall_back() {
        let config = Config::from_sources(
            "openai_api_key = 'file-key'\nlisten = '127.0.0.1:9090'",
            |key| match key {
                "OPENAI_API_KEY" => Some("env-key".into()),
                "LISTEN" => Some("127.0.0.1:9091".into()),
                "OPENAI_TRANSCRIBE_MODEL" => Some(" ".into()),
                _ => None,
            },
        )
        .unwrap();
        assert_eq!(config.api_key, "env-key");
        assert_eq!(config.listen, "127.0.0.1:9091".parse().unwrap());
        assert_eq!(config.model, "gpt-transcribe");
    }

    #[test]
    fn validation_errors_do_not_disclose_secrets() {
        for source in [
            "openai_api_key = 'secret-key'\nlisten = 'invalid'",
            "openai_api_key = 123456789",
            "openai_api_key = 'secret-key'\nunknown_field = 'secret-key'",
            "openai_api_key = 'secret-key",
            "openai_api_key = ''",
        ] {
            let error = Config::from_sources(source, |_| None).err().unwrap();
            assert!(!error.contains("secret-key"));
            assert!(!error.contains("123456789"));
        }
    }

    #[test]
    fn explicitly_selected_file_must_exist() {
        let dir = tempfile::tempdir().unwrap();
        let error = Config::load(&dir.path().join("missing.toml"), true).err().unwrap();
        assert!(error.contains("cannot read config"));
    }
}
