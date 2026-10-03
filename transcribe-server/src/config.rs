//! TOML configuration with environment overrides for local experiments and CI.

use std::{net::SocketAddr, path::Path};

use serde::Deserialize;

pub struct Config {
    pub listen: SocketAddr,
    pub api_key: String,
    pub model: String,
    pub google: Option<GoogleConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GoogleConfig {
    pub project_id: String,
    pub location: String,
    pub model: String,
}

impl Default for GoogleConfig {
    fn default() -> Self {
        Self {
            project_id: String::new(),
            location: "global".into(),
            model: "short".into(),
        }
    }
}

impl GoogleConfig {
    pub fn endpoint(&self) -> String {
        if self.location == "global" {
            "https://speech.googleapis.com".into()
        } else {
            format!("https://{}-speech.googleapis.com", self.location)
        }
    }

    pub fn recognizer(&self) -> String {
        format!("projects/{}/locations/{}/recognizers/_", self.project_id, self.location)
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    listen: Option<String>,
    openai_api_key: Option<String>,
    model: Option<String>,
    google: Option<GoogleConfig>,
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
        let file: FileConfig = toml::from_str(source).map_err(|_| {
            "invalid TOML; expected listen, model, openai_api_key and optional [google] settings".to_owned()
        })?;
        let clean = |value: Option<String>| {
            value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let value = |key, fallback| clean(env(key)).or_else(|| clean(fallback));
        let api_key = value("OPENAI_API_KEY", file.openai_api_key).unwrap_or_default();
        let mut google = file.google.unwrap_or_default();
        google.project_id = value("GOOGLE_CLOUD_PROJECT", Some(google.project_id)).unwrap_or_default();
        google.location = value("GOOGLE_SPEECH_LOCATION", Some(google.location)).unwrap_or_else(|| "global".into());
        google.model = value("GOOGLE_SPEECH_MODEL", Some(google.model)).unwrap_or_else(|| "short".into());
        let google = if google.project_id.is_empty() {
            None
        } else {
            for (name, field) in [("project_id", &google.project_id), ("location", &google.location)] {
                if !field.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
                    return Err(format!(
                        "google.{name} must contain only ASCII letters, digits and hyphens"
                    ));
                }
            }
            Some(google)
        };
        if api_key.is_empty() && google.is_none() {
            return Err("set openai_api_key / OPENAI_API_KEY or google.project_id / GOOGLE_CLOUD_PROJECT".into());
        }
        let listen = value("LISTEN", file.listen)
            .unwrap_or_else(|| "127.0.0.1:8081".into())
            .parse()
            .map_err(|_| "listen must be an IP address and port, e.g. 127.0.0.1:8081")?;
        let model = value("OPENAI_TRANSCRIBE_MODEL", file.model).unwrap_or_else(|| "gpt-transcribe".into());
        Ok(Self {
            listen,
            api_key,
            model,
            google,
        })
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

    #[test]
    fn google_only_uses_adc_and_global_short_defaults() {
        let config = Config::from_sources("[google]\nproject_id = 'radio-lab'", |_| None).unwrap();
        assert!(config.api_key.is_empty());
        let google = config.google.unwrap();
        assert_eq!(google.model, "short");
        assert_eq!(google.endpoint(), "https://speech.googleapis.com");
        assert_eq!(google.recognizer(), "projects/radio-lab/locations/global/recognizers/_");
    }

    #[test]
    fn google_environment_overrides_and_regional_endpoint() {
        let config = Config::from_sources("[google]\nproject_id = 'file-project'", |key| match key {
            "GOOGLE_CLOUD_PROJECT" => Some("env-project".into()),
            "GOOGLE_SPEECH_LOCATION" => Some("us-central1".into()),
            "GOOGLE_SPEECH_MODEL" => Some("chirp_3".into()),
            _ => None,
        })
        .unwrap();
        let google = config.google.unwrap();
        assert_eq!(google.project_id, "env-project");
        assert_eq!(google.model, "chirp_3");
        assert_eq!(google.endpoint(), "https://us-central1-speech.googleapis.com");
    }

    #[test]
    fn empty_google_table_is_disabled_and_resource_segments_are_validated() {
        let config = Config::from_sources("openai_api_key = 'test-key'\n[google]\nproject_id = ''", |_| None).unwrap();
        assert!(config.google.is_none());
        for source in [
            "[google]\nproject_id = '../bad'",
            "[google]\nproject_id = 'radio-lab'\nlocation = 'bad/host'",
        ] {
            assert!(Config::from_sources(source, |_| None).is_err());
        }
    }
}
