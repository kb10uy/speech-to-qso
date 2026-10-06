//! Backend for speech-to-qso.
//!
//! Serves the web app and its API on one origin. Users sign in with passkeys only; their first
//! passkey is registered through a one-time link issued on the server. QSOs are stored in SQLite
//! and forwarded to each user's Wavelog. Secrets such as Wavelog API tokens stay here and never
//! reach the browser.

pub mod adif;
pub mod admin;
pub mod api;
pub mod band;
pub mod config;
pub mod db;
pub mod error;
pub mod logbook;
pub mod passkeys;
pub mod qso;
pub mod sessions;
pub mod stations;
pub mod users;
pub mod wavelog;
