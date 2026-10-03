//! Thin backend for speech-to-qso.
//!
//! Receives QSOs logged by the web client, keeps them in an append-only local log (JSON lines
//! and ADIF) and forwards them to Wavelog. Secrets such as the Wavelog API key stay here and
//! never reach the browser.

pub mod adif;
pub mod api;
pub mod band;
pub mod config;
pub mod qso;
pub mod store;
pub mod wavelog;
