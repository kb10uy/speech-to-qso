use std::sync::Arc;

use speech_to_qso_server::{
    api::{AppState, router},
    config::Config,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env()?;
    if config.api_token.is_none() {
        tracing::warn!("API_TOKEN is not set; anyone who can reach this server can log QSOs");
    }
    match &config.wavelog {
        Some(w) => tracing::info!("forwarding QSOs to Wavelog at {}", w.url),
        None => tracing::info!("Wavelog is not configured; QSOs are only stored locally"),
    }

    let state = Arc::new(AppState::new(&config).await?);
    let app = router(state, &config.allowed_origins);
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
