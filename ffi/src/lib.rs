//! React Native FFI shim for the Payjoin Dev Kit.
//!
//! Unlike `react-native-bdk-sdk` — which hand-writes its uniffi surface — the
//! payjoin project already ships `payjoin-ffi`, a uniffi wrapper used by the
//! Python / Dart / JavaScript / C# bindings. We re-export it verbatim so the
//! React Native bindings track upstream exactly, and add only the one thing
//! `payjoin-ffi` deliberately leaves out: OHTTP key fetching.
//!
//! ## Why OHTTP key fetching lives here and not in TypeScript
//!
//! `payjoin::io::fetch_ohttp_keys` proxies the request to the payjoin
//! directory through an HTTP `CONNECT` relay so the client's IP address is
//! never revealed to the directory. React Native's `fetch`/XHR cannot issue a
//! `CONNECT`, so this cannot be reimplemented in JS without leaking the IP.
//!
//! Relay POST/GET transport is the opposite case: it is a plain HTTPS request
//! of `Request { url, content_type, body }`, so it is handled in TypeScript
//! where callers keep control of timeouts, retries, and proxying.

// Re-export the whole upstream API surface.
pub use payjoin_ffi::*;

use std::sync::LazyLock;

/// Global Tokio runtime for async methods.
///
/// uniffi polls Rust futures without entering a Tokio runtime context, so
/// `reqwest`'s async I/O inside `fetch_ohttp_keys` would panic without this.
/// Mirrors the pattern used by `react-native-bdk-sdk`.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create Tokio runtime")
});

/// Errors from fetching OHTTP keys.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum OhttpKeysFetchError {
    /// The relay or directory URL was malformed, unreachable, returned a
    /// non-success status, or returned keys that failed to decode.
    #[error("Failed to fetch OHTTP keys: {message}")]
    Fetch { message: String },
}

/// Fetch the OHTTP keys for a payjoin directory, proxied via an OHTTP relay.
///
/// * `ohttp_relay` — HTTP `CONNECT` proxy used to request the keys. Proxying
///   ensures the client IP address is never revealed to the directory.
/// * `payjoin_directory` — directory to fetch the keys from. It stores and
///   forwards payjoin client payloads.
///
/// Returns keys suitable for passing to a receiver session.
#[uniffi::export(async_runtime = "tokio")]
pub async fn fetch_ohttp_keys(
    ohttp_relay: String,
    payjoin_directory: String,
) -> Result<std::sync::Arc<OhttpKeys>, OhttpKeysFetchError> {
    // Spawn onto our runtime so reqwest has a reactor to drive its I/O.
    RUNTIME
        .spawn(async move {
            payjoin::io::fetch_ohttp_keys(ohttp_relay, payjoin_directory)
                .await
                .map(|keys| std::sync::Arc::new(OhttpKeys::from(keys)))
                .map_err(|e| OhttpKeysFetchError::Fetch {
                    message: e.to_string(),
                })
        })
        .await
        .map_err(|e| OhttpKeysFetchError::Fetch {
            message: format!("OHTTP key fetch task panicked: {e}"),
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A malformed relay URL must surface as a catchable `Fetch` error, not a
    /// panic — this also exercises the runtime spawn path without any network.
    #[test]
    fn fetch_ohttp_keys_rejects_invalid_urls() {
        let result = RUNTIME.block_on(fetch_ohttp_keys(
            "not a url".to_string(),
            "also not a url".to_string(),
        ));
        assert!(matches!(result, Err(OhttpKeysFetchError::Fetch { .. })));
    }

    /// The message must survive into the Display output, since that string is
    /// all the JS side ever sees of the underlying error.
    #[test]
    fn fetch_error_display_includes_message() {
        let err = OhttpKeysFetchError::Fetch {
            message: "boom".to_string(),
        };
        assert_eq!(err.to_string(), "Failed to fetch OHTTP keys: boom");
    }
}
