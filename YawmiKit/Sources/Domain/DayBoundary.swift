import Foundation

/// A local calendar day, written `YYYY-MM-DD` on the wire.
///
/// Days are compared and counted on the proleptic Gregorian calendar with no time zone: the zone
/// only matters when an instant is turned into a day (`DayBoundary.dayKey(for:timeZone:)`).
public struct DayKey: Hashable, Comparable, Codable, Sendable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    /// Builds a key from calendar components. The caller supplies a real calendar day; parse
    /// untrusted text with `init?(isoString:)`, which validates.
    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// Parses exactly `YYYY-MM-DD` (ASCII digits, a real calendar day), else `nil`.
    public init?(isoString: String) {
        let bytes = Array(isoString.utf8)
        guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-") else { return nil }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for byte in bytes[range] {
                guard (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) else { return nil }
                value = value * 10 + Int(byte - UInt8(ascii: "0"))
            }
            return value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
              Self.isValid(year: year, month: month, day: day)
        else { return nil }
        self.init(year: year, month: month, day: day)
    }

    /// Whole days since 1970-01-01 (negative before it), on the proleptic Gregorian calendar.
    public init(epochDay: Int) {
        // Howard Hinnant's `civil_from_days`, shifted so the era starts on 0000-03-01
        let z = epochDay + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthIndex = (5 * dayOfYear + 2) / 153  // March = 0
        let day = dayOfYear - (153 * monthIndex + 2) / 5 + 1
        let month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9
        let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        self.init(year: year, month: month, day: day)
    }

    /// Whole days since 1970-01-01 (negative before it).
    public var epochDay: Int {
        // Howard Hinnant's `days_from_civil`
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let monthIndex = (month + 9) % 12  // March = 0
        let dayOfYear = (153 * monthIndex + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    public var description: String {
        func padded(_ value: Int, _ width: Int) -> String {
            let digits = String(value)
            return String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        return "\(padded(year, 4))-\(padded(month, 2))-\(padded(day, 2))"
    }

    public static func < (lhs: DayKey, rhs: DayKey) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    public init(from decoder: any Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let key = DayKey(isoString: text) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Expected a calendar day written YYYY-MM-DD, found \"\(text)\""
                )
            )
        }
        self = key
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    static func isValid(year: Int, month: Int, day: Int) -> Bool {
        guard (1...12).contains(month), day >= 1 else { return false }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return day <= lengths[month - 1]
    }
}

/// Turning instants into local days.
public enum DayBoundary {
    /// `Asia/Riyadh`: UTC+03:00 all year, no daylight saving. A fixed offset keeps the app
    /// independent of the platform's time zone database.
    public static let riyadh: TimeZone = {
        guard let zone = TimeZone(secondsFromGMT: 3 * 3600) else {
            preconditionFailure("UTC+03:00 is a valid fixed offset")
        }
        return zone
    }()

    /// The local day that contains `date` in `timeZone`.
    public static func dayKey(for date: Date, timeZone: TimeZone) -> DayKey {
        let localSeconds = date.timeIntervalSince1970.rounded(.down) + Double(timeZone.secondsFromGMT(for: date))
        // clamp so an absurd date cannot trap in the Int conversion (about 3 million years)
        let seconds = Int(max(-1e14, min(1e14, localSeconds)))
        return DayKey(epochDay: floorDivide(seconds, 86_400))
    }
}

/// Integer division rounding toward negative infinity (`/` truncates toward zero).
func floorDivide(_ value: Int, _ divisor: Int) -> Int {
    let quotient = value / divisor
    return (value % divisor != 0 && (value < 0) != (divisor < 0)) ? quotient - 1 : quotient
}
