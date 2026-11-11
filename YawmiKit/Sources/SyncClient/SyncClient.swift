import Domain

/// Placeholder for the offline event queue and sync client (Task 22).
///
/// It exists now so the package declares both products from the start. Foundation only, like
/// `Domain`.
public enum SyncClient {
    // TODO(Task 22): persistent event queue, batching, resend-safe flush (`POST /v1/events`).
}
