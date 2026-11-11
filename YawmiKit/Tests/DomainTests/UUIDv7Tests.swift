import Domain
import Foundation
import Testing

/// RFC 9562 §5.7: 48-bit big-endian Unix milliseconds, version 7, 12 random bits, variant `10`,
/// 62 random bits.
struct UUIDv7Tests {
    private static func date(milliseconds: UInt64) -> Date {
        Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    }

    private static func bytes(_ uuid: UUID) -> [UInt8] {
        withUnsafeBytes(of: uuid.uuid) { Array($0) }
    }

    private static func filled(with byte: UInt8) -> (Int) -> [UInt8] {
        { count in [UInt8](repeating: byte, count: count) }
    }

    @Test(arguments: [UInt8(0x00), 0xFF, 0xA5])
    func versionNibbleIsSevenAndVariantBitsAreTenForAnyRandomness(fill: UInt8) {
        let uuid = UUIDv7.generate(now: Self.date(milliseconds: 1_794_257_999_123), random: Self.filled(with: fill))
        let bytes = Self.bytes(uuid)
        #expect(bytes[6] >> 4 == 0b0111)
        #expect(bytes[8] >> 6 == 0b10)
        let chars = Array(uuid.uuidString.lowercased())
        #expect(chars[14] == "7")
        #expect("89ab".contains(chars[19]))
    }

    @Test
    func matchesRFC9562AppendixAExample() {
        // unix_ts_ms = 0x017F22E279B0, rand_a = 0xCC3, rand_b = 0x18C4DC0C0C07398F
        let random: [UInt8] = [0x0C, 0xC3, 0x18, 0xC4, 0xDC, 0x0C, 0x0C, 0x07, 0x39, 0x8F]
        let uuid = UUIDv7.generate(now: Self.date(milliseconds: 0x017F_22E2_79B0)) { count in
            #expect(count == 10)
            return random
        }
        #expect(uuid.uuidString.lowercased() == "017f22e2-79b0-7cc3-98c4-dc0c0c07398f")
    }

    @Test
    func randomBytesAreUsedVerbatimOutsideVersionAndVariantBits() {
        let random: [UInt8] = [0xFA, 0x12, 0xFF, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]
        let uuid = UUIDv7.generate(now: Self.date(milliseconds: 1)) { _ in random }
        let bytes = Self.bytes(uuid)
        #expect(bytes[6] == 0x7A)  // version nibble over the low nibble of the first random byte
        #expect(bytes[7] == 0x12)
        #expect(bytes[8] == 0xBF)  // variant bits over the low six bits of the third random byte
        #expect(Array(bytes[9...]) == [0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0])
    }

    @Test
    func idsSortLexicallyByIncreasingTime() {
        let times: [UInt64] = [
            0, 1, 2, 1_000, 4_294_967_295, 4_294_967_296,
            1_794_257_999_123, 1_794_257_999_124, 1_794_258_000_000, 281_474_976_710_654,
        ]
        let ids = times.map {
            UUIDv7.generate(now: Self.date(milliseconds: $0), random: Self.filled(with: 0x00)).uuidString.lowercased()
        }
        #expect(ids == ids.sorted())
        #expect(Set(ids).count == ids.count)
    }

    @Test
    func idsSortLexicallyEvenWithUnrelatedRandomness() {
        let base: UInt64 = 1_794_257_999_000
        let ids = (0..<200).map { offset in
            UUIDv7.generate(now: Self.date(milliseconds: base + UInt64(offset))).uuidString.lowercased()
        }
        #expect(ids == ids.sorted())
    }

    @Test(arguments: [UInt64(0), 1, 999, 1_794_257_999_123, 281_474_976_710_655])
    func timestampRoundTripsThroughFortyEightBits(milliseconds: UInt64) {
        let uuid = UUIDv7.generate(now: Self.date(milliseconds: milliseconds), random: Self.filled(with: 0xFF))
        #expect(UUIDv7.unixMilliseconds(of: uuid) == milliseconds)
    }

    @Test
    func timestampIsClampedToTheFortyEightBitRange() {
        let before = UUIDv7.generate(now: Date(timeIntervalSince1970: -5), random: Self.filled(with: 0))
        #expect(UUIDv7.unixMilliseconds(of: before) == 0)
        let after = UUIDv7.generate(now: Date(timeIntervalSince1970: 1e15), random: Self.filled(with: 0))
        #expect(UUIDv7.unixMilliseconds(of: after) == 281_474_976_710_655)
    }

    @Test
    func defaultsUseTheClockAndSystemRandomness() {
        let started = Date()
        let ids = (0..<1_000).map { _ in UUIDv7.generate() }
        #expect(Set(ids).count == ids.count)
        let stamp = Double(UUIDv7.unixMilliseconds(of: ids[0])) / 1000
        #expect(abs(stamp - started.timeIntervalSince1970) < 5)
        #expect(ids.allSatisfy { Self.bytes($0)[6] >> 4 == 7 && Self.bytes($0)[8] >> 6 == 0b10 })
    }
}
