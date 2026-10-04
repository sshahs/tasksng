//! Platform independent core of TasksNG: iCalendar handling, a CalDAV client
//! tuned for Baikal (sabre/dav) and an offline-first task store.

pub mod alarms;
pub mod dates;
pub mod dav;
pub mod ical;
pub mod model;
pub mod recur;
pub mod reminders;
pub mod store;
pub mod sync;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Can't reach the server ({0})")]
    Network(String),
    #[error("The server's TLS certificate isn't trusted ({0}). Add your certificate authority to the system's trusted certificates, or enable “Accept invalid TLS certificates” under Advanced.")]
    Certificate(String),
    #[error("The server rejected the username or password")]
    Unauthorized,
    #[error("No CalDAV service was found at this address. Try the full URL of Baikal's dav.php, e.g. https://example.com/dav.php")]
    Discovery,
    #[error("The server returned an error ({status}): {message}")]
    Http { status: u16, message: String },
    #[error("Unexpected server response: {0}")]
    Protocol(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Model(#[from] model::ModelError),
    #[error("Could not save local data: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Errors that mean "try again later" rather than "something is wrong".
    pub fn is_offline(&self) -> bool {
        matches!(self, Error::Network(_))
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
