//! Errors shared by the API handlers and the admin commands.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    BadRequest(String),
    #[error("not signed in")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unprocessable(String),
    #[error("{0}")]
    TooManyRequests(String),
    #[error("{0}")]
    BadGateway(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn status(&self) -> StatusCode {
        match self {
            Error::BadRequest(_) => StatusCode::BAD_REQUEST,
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden(_) => StatusCode::FORBIDDEN,
            Error::NotFound(_) => StatusCode::NOT_FOUND,
            Error::Conflict(_) => StatusCode::CONFLICT,
            Error::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Error::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            Error::BadGateway(_) => StatusCode::BAD_GATEWAY,
            Error::Database(_) | Error::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = self.status();
        let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!("{self}");
            "internal server error".to_string()
        } else {
            self.to_string()
        };
        (status, Json(json!({ "status": "error", "error": message }))).into_response()
    }
}
