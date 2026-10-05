use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use chrono::TimeDelta;
use clap::{Parser, Subcommand};
use speech_to_qso_server::{
    admin,
    api::{AppState, router},
    config::parse_public_origin,
    db, passkeys, users,
};
use tracing_subscriber::EnvFilter;
use url::Url;

#[derive(Parser)]
#[command(version, about = "Serves speech-to-qso and manages its users")]
struct Cli {
    /// SQLite database file.
    #[arg(long, env = "DATABASE_PATH", default_value = "data/speech-to-qso.db", global = true)]
    database: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serves the web app and the API.
    Serve {
        #[arg(long, env = "LISTEN", default_value = "127.0.0.1:8080")]
        listen: SocketAddr,
        /// URL the app is reached at, e.g. https://qso.example.com. Passkeys are bound to its host.
        #[arg(long, env = "PUBLIC_ORIGIN", value_parser = parse_public_origin)]
        public_origin: Url,
        /// The built web app (web/build). Without it only the API is served.
        #[arg(long, env = "WEB_DIR")]
        web_dir: Option<PathBuf>,
    },
    /// Manages users.
    #[command(subcommand)]
    User(UserCommand),
    /// Manages passkeys.
    #[command(subcommand)]
    Passkey(PasskeyCommand),
}

#[derive(Subcommand)]
enum UserCommand {
    /// Creates a user. Register their first passkey with `passkey bootstrap`.
    Create { callsign: String },
    /// Lists users.
    List,
    /// Changes a user's callsign.
    Rename { callsign: String, new_callsign: String },
    /// Deletes a user with all their passkeys, stations and QSOs.
    Delete { callsign: String },
}

#[derive(Subcommand)]
enum PasskeyCommand {
    /// Prints a one-time link that registers the first passkey of a user.
    Bootstrap {
        callsign: String,
        #[arg(long, env = "PUBLIC_ORIGIN", value_parser = parse_public_origin)]
        public_origin: Url,
        /// How long the link stays valid, e.g. 10m or 1h.
        #[arg(long, default_value = "10m", value_parser = admin::parse_duration)]
        expires: TimeDelta,
    },
    /// Lists the passkeys of a user.
    List { callsign: String },
    /// Revokes a passkey, or with --all every passkey (and session) of a user.
    Revoke {
        callsign: String,
        #[arg(required_unless_present = "all")]
        id: Option<String>,
        #[arg(long, conflicts_with = "id")]
        all: bool,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let db = db::open(&cli.database).await?;

    match cli.command {
        Command::Serve {
            listen,
            public_origin,
            web_dir,
        } => {
            match &web_dir {
                Some(dir) if !dir.join("index.html").is_file() => {
                    return Err(format!("{} has no index.html; build the web app first", dir.display()).into());
                }
                Some(dir) => tracing::info!("serving the web app from {}", dir.display()),
                None => tracing::warn!("WEB_DIR is not set; serving the API only"),
            }
            let state = Arc::new(AppState::new(db, &public_origin)?);
            let app = router(state, web_dir.as_deref());
            let listener = tokio::net::TcpListener::bind(listen).await?;
            tracing::info!("listening on http://{} for {public_origin}", listener.local_addr()?);
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
        Command::User(UserCommand::Create { callsign }) => {
            let user = users::create(&db, &callsign).await?;
            println!("Created {} ({})", user.callsign, user.id);
            println!("Next: passkey bootstrap {}", user.callsign);
        }
        Command::User(UserCommand::List) => {
            for user in users::list(&db).await? {
                let count = passkeys::count(&db, user.id).await?;
                println!("{}\t{}\t{count} passkey(s)", user.callsign, user.id);
            }
        }
        Command::User(UserCommand::Rename { callsign, new_callsign }) => {
            let user = users::rename(&db, &callsign, &new_callsign).await?;
            println!("Renamed to {}", user.callsign);
        }
        Command::User(UserCommand::Delete { callsign }) => {
            let user = users::delete(&db, &callsign).await?;
            println!("Deleted {}", user.callsign);
        }
        Command::Passkey(PasskeyCommand::Bootstrap {
            callsign,
            public_origin,
            expires,
        }) => {
            let link = admin::bootstrap_link(&db, &public_origin, &callsign, expires).await?;
            println!(
                "Open this link to register the first passkey of {}:",
                callsign.to_uppercase()
            );
            println!();
            println!("{link}");
            println!();
            println!("It works once and expires in {} minute(s).", expires.num_minutes());
        }
        Command::Passkey(PasskeyCommand::List { callsign }) => {
            let user = users::get_by_callsign(&db, &callsign).await?;
            for p in passkeys::list(&db, user.id).await? {
                let last_used = p.last_used_at.as_deref().unwrap_or("never");
                println!("{}\t{}\tcreated {}\tlast used {last_used}", p.id, p.name, p.created_at);
            }
        }
        Command::Passkey(PasskeyCommand::Revoke { callsign, id, .. }) => {
            let count = admin::revoke_passkeys(&db, &callsign, id.as_deref()).await?;
            println!("Revoked {count} passkey(s)");
        }
    }
    Ok(())
}
