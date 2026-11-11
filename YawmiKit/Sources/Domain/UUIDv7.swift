import Foundation

/// UUID version 7 (RFC 9562 §5.7): a 48-bit big-endian Unix-millisecond timestamp, so ids sort by
/// creation time and make good primary keys for the append-only event log. Event ids are minted
/// on the device and are the idempotency key (`ON CONFLICT (id) DO NOTHING`).
///
/// ```
///  0                   1                   2                   3
///  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
/// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
/// |                           unix_ts_ms                          |
/// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
/// |          unix_ts_ms           |  ver  |       rand_a          |
/// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
/// |var|                        rand_b                             |
/// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
/// |                            rand_b                             |
/// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
/// ```
///
/// Ids minted within the same millisecond are ordered by their random bits (RFC 9562 §6.2 allows
/// that); nothing here depends on sub-millisecond order.
public enum UUIDv7 {
    /// The largest value the 48-bit timestamp field holds.
    static let maxMilliseconds: UInt64 = (1 << 48) - 1

    /// Mints an id for `now`.
    ///
    /// - Parameter random: returns `count` random bytes; it is called once with `10`. The default
    ///   draws from the system generator; tests pass a fixed sequence.
    public static func generate(
        now: Date = Date(),
        random: (Int) -> [UInt8] = UUIDv7.systemRandom
    ) -> UUID {
        let milliseconds = clampedMilliseconds(now)
        let entropy = random(10)
        precondition(entropy.count >= 10, "UUIDv7 needs 10 random bytes, got \(entropy.count)")

        var bytes = [UInt8](repeating: 0, count: 16)
        for index in 0..<6 {
            bytes[index] = UInt8(truncatingIfNeeded: milliseconds >> UInt64(8 * (5 - index)))
        }
        bytes[6] = 0x70 | (entropy[0] & 0x0F)  // version 7 over rand_a
        bytes[7] = entropy[1]
        bytes[8] = 0x80 | (entropy[2] & 0x3F)  // variant 10 over rand_b
        for index in 9..<16 {
            bytes[index] = entropy[index - 6]
        }
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    /// The Unix-millisecond timestamp stored in the first 48 bits of `uuid`.
    public static func unixMilliseconds(of uuid: UUID) -> UInt64 {
        withUnsafeBytes(of: uuid.uuid) { bytes in
            bytes.prefix(6).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        }
    }

    /// `count` bytes from the system's cryptographically secure generator.
    public static func systemRandom(_ count: Int) -> [UInt8] {
        var generator = SystemRandomNumberGenerator()
        return (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    }

    /// Rounds to the nearest millisecond (so a `Date` built from whole milliseconds maps back to
    /// them despite floating-point error) and clamps to the 48-bit field.
    private static func clampedMilliseconds(_ date: Date) -> UInt64 {
        let milliseconds = (date.timeIntervalSince1970 * 1000).rounded()
        if milliseconds.isNaN || milliseconds <= 0 { return 0 }
        if milliseconds >= Double(maxMilliseconds) { return maxMilliseconds }
        return UInt64(milliseconds)
    }
}
