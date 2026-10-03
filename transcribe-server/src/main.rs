use std::{path::PathBuf, sync::Arc};

use speech_to_qso_transcribe_server::{AppState, config::Config, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let (path, required) = match args.as_slice() {
        [] => (PathBuf::from("config.toml"), false),
        [flag, path] if flag == "--config" => (PathBuf::from(path), true),
        [flag] if flag == "--help" || flag == "-h" => {
            println!("Usage: speech-to-qso-transcribe-server [--config PATH]\nDefault config: ./config.toml");
            return Ok(());
        }
        _ => return Err("Usage: speech-to-qso-transcribe-server [--config PATH]".into()),
    };
    let config = Config::load(&path, required)?;
    let state = Arc::new(AppState::new(config.openai.api_key, config.openai.model)?.with_google(config.google));
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(
        "transcription experiment listening on http://{}",
        listener.local_addr()?
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
