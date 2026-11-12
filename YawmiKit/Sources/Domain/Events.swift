import Foundation

/// A JSON document, for event payloads and the shared domain vectors.
///
/// Numbers are `Double`s that print the way JSON writers expect: a whole number is written
/// without a decimal point (`3`, not `3.0`) and anything else with its shortest exact form
/// (`0.5`). Whole numbers beyond 2^53 lose integer exactness, as in JavaScript and Python's
/// `float`; nothing in the event schema is that large.
public enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The number as an `Int` when it is a whole number in `Int`'s range, else `nil`.
    public var intValue: Int? {
        guard case .number(let value) = self, value.rounded() == value,
              value >= -9_007_199_254_740_992, value <= 9_007_199_254_740_992
        else { return nil }
        return Int(value)
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// The member `key` of an object, or `nil` for a missing key or a non-object.
    public subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }
}

extension JSONValue: Codable {
    /// Whole numbers below this magnitude are written as integers.
    private static let exactIntegerLimit = 9_007_199_254_740_992.0  // 2^53

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a JSON value")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            if value.rounded() == value, abs(value) < Self.exactIntegerLimit {
                try container.encode(Int64(value))
            } else {
                try container.encode(value)
            }
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }
}

/// The type of an event. The ten types `POST /v1/events` accepts (`EventType` in
/// `api/yawmi/events/project.py` and the `EventIn.type` enum in `openapi/openapi.json`) are the
/// static members; `allKnown` lists them in the server's order.
///
/// It is an open set rather than an `enum`: `GET /v1/events` returns `type` as a plain string, so
/// a client must still decode an event that a newer server or client wrote with a type it does
/// not know. `isKnown` tells the two apart.
public struct EventType: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let habitLogged = EventType(rawValue: "habit_logged")
    public static let habitSkipped = EventType(rawValue: "habit_skipped")
    public static let habitVacation = EventType(rawValue: "habit_vacation")
    public static let dayClosed = EventType(rawValue: "day_closed")
    public static let focusStarted = EventType(rawValue: "focus_started")
    public static let focusEnded = EventType(rawValue: "focus_ended")
    public static let breathEnded = EventType(rawValue: "breath_ended")
    public static let moodLogged = EventType(rawValue: "mood_logged")
    public static let confounderTagged = EventType(rawValue: "confounder_tagged")
    public static let appOpened = EventType(rawValue: "app_opened")
    public static let journalSaved = EventType(rawValue: "journal_saved")
    public static let goalTaskSet = EventType(rawValue: "goal_task_set")

    /// The types the server accepts, in its order.
    public static let allKnown: [EventType] = [
        .habitLogged, .habitSkipped, .habitVacation, .dayClosed, .focusStarted,
        .focusEnded, .breathEnded, .moodLogged, .confounderTagged, .appOpened,
        .journalSaved, .goalTaskSet,
    ]

    /// Whether the server accepts this type in `POST /v1/events`.
    public var isKnown: Bool { Self.allKnown.contains(self) }

    public var description: String { rawValue }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// An event as clients queue it and `POST /v1/events` takes it (`EventIn`), and as
/// `GET /v1/events` returns it (`StoredEvent`, whose server-only fields `device_id` and
/// `received_at` decoding ignores).
///
/// On the wire: `{"id", "type", "payload", "occurred_at", "tz"}`.
/// - `id` is a UUIDv7 minted on the device (the idempotency key), written in lower case.
/// - `payload` is a JSON object, as the schema requires (`"type": "object"`). The typed payloads
///   in `EventPayloads.swift` cover the four types the server projects into tables; every other
///   type may carry any object.
/// - `occurred_at` is an ISO 8601 instant with milliseconds in UTC (`2026-11-09T20:59:59.123Z`).
///   The server accepts years 2000 to 2099 and at most 24 hours ahead of its clock.
/// - `tz` is the IANA zone naming the local day of the event; the server defaults a missing one
///   to `Asia/Riyadh`, and decoding does the same.
public struct EventEnvelope: Codable, Sendable, Hashable, Identifiable {
    /// The zone the server assumes when `tz` is missing (`DEFAULT_TZ` in `api/yawmi/domain/days.py`).
    public static let defaultTimeZone = "Asia/Riyadh"

    public var id: UUID
    public var type: EventType
    public var payload: [String: JSONValue]
    public var occurredAt: Date
    public var tz: String

    public init(
        id: UUID,
        type: EventType,
        payload: [String: JSONValue],
        occurredAt: Date,
        tz: String = EventEnvelope.defaultTimeZone
    ) {
        self.id = id
        self.type = type
        self.payload = payload
        self.occurredAt = occurredAt
        self.tz = tz
    }

    /// An event carrying a typed payload, under the type that payload belongs to.
    public init<Payload: EventPayload>(
        id: UUID = UUIDv7.generate(),
        payload: Payload,
        occurredAt: Date,
        tz: String = EventEnvelope.defaultTimeZone
    ) throws {
        self.init(id: id, type: Payload.eventType, payload: try payload.jsonObject(), occurredAt: occurredAt, tz: tz)
    }

    /// The payload read as `Payload`. Throws `DecodingError` when the event's type is not
    /// `Payload.eventType` or the payload does not fit; extra fields are ignored, as on the server.
    public func decodePayload<Payload: EventPayload>(as _: Payload.Type) throws -> Payload {
        guard type == Payload.eventType else {
            throw DecodingError.typeMismatch(
                Payload.self,
                .init(codingPath: [], debugDescription: "A \(type) event does not carry a \(Payload.self)")
            )
        }
        return try Payload(jsonObject: payload)
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, payload, tz
        case occurredAt = "occurred_at"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let idText = try container.decode(String.self, forKey: .id)
        guard let id = UUID(uuidString: idText) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: container, debugDescription: "Not a UUID: \"\(idText)\"")
        }

        let instantText = try container.decode(String.self, forKey: .occurredAt)
        guard let occurredAt = ISO8601Instant.parse(instantText) else {
            throw DecodingError.dataCorruptedError(
                forKey: .occurredAt,
                in: container,
                debugDescription: "Not an ISO 8601 instant with a UTC offset: \"\(instantText)\""
            )
        }

        self.init(
            id: id,
            type: try container.decode(EventType.self, forKey: .type),
            payload: try container.decode([String: JSONValue].self, forKey: .payload),
            occurredAt: occurredAt,
            tz: try container.decodeIfPresent(String.self, forKey: .tz) ?? Self.defaultTimeZone
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id.uuidString.lowercased(), forKey: .id)
        try container.encode(type, forKey: .type)
        try container.encode(payload, forKey: .payload)
        try container.encode(ISO8601Instant.format(occurredAt), forKey: .occurredAt)
        try container.encode(tz, forKey: .tz)
    }
}

/// ISO 8601 instants, written and read by hand so the wire format does not depend on the platform's
/// Foundation: `YYYY-MM-DDTHH:MM:SS.mmmZ` out; in, any fraction length (down to nothing) and `Z`,
/// `+HH:MM` or `+HHMM`. A text without an offset is refused, since an instant needs one. These
/// are the three forms the shared vectors use (`day_key-006` and `day_key-013`).
public enum ISO8601Instant {
    /// `date` as `YYYY-MM-DDTHH:MM:SS.mmmZ`, rounded to the nearest millisecond.
    public static func format(_ date: Date) -> String {
        let milliseconds = Int((max(-1e14, min(1e14, date.timeIntervalSince1970 * 1000))).rounded())
        let seconds = floorDivide(milliseconds, 1000)
        let epochDay = floorDivide(seconds, 86_400)
        let secondOfDay = seconds - epochDay * 86_400

        func padded(_ value: Int, _ width: Int) -> String {
            let digits = String(value)
            return String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        return "\(DayKey(epochDay: epochDay))T"
            + "\(padded(secondOfDay / 3600, 2)):\(padded(secondOfDay / 60 % 60, 2)):\(padded(secondOfDay % 60, 2))"
            + ".\(padded(milliseconds - seconds * 1000, 3))Z"
    }

    /// The instant, truncated to whole milliseconds, or `nil` when `text` is not an instant.
    public static func parse(_ text: String) -> Date? {
        let bytes = Array(text.utf8)
        var index = 0

        func digits(_ count: Int) -> Int? {
            guard index + count <= bytes.count else { return nil }
            var value = 0
            for byte in bytes[index..<index + count] {
                guard (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) else { return nil }
                value = value * 10 + Int(byte - UInt8(ascii: "0"))
            }
            index += count
            return value
        }
        func skip(_ expected: UInt8...) -> Bool {
            guard index < bytes.count, expected.contains(bytes[index]) else { return false }
            index += 1
            return true
        }

        guard let year = digits(4), skip(UInt8(ascii: "-")),
              let month = digits(2), skip(UInt8(ascii: "-")),
              let day = digits(2), DayKey.isValid(year: year, month: month, day: day),
              skip(UInt8(ascii: "T"), UInt8(ascii: "t"), UInt8(ascii: " ")),
              let hour = digits(2), skip(UInt8(ascii: ":")),
              let minute = digits(2), skip(UInt8(ascii: ":")),
              let second = digits(2),
              hour < 24, minute < 60, second < 60
        else { return nil }

        var fractionMilliseconds = 0
        if skip(UInt8(ascii: "."), UInt8(ascii: ",")) {
            let start = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
            guard index > start else { return nil }
            var place = 100
            for byte in bytes[start..<min(index, start + 3)] {
                fractionMilliseconds += Int(byte - UInt8(ascii: "0")) * place
                place /= 10
            }
        }

        var offsetSeconds = 0
        if skip(UInt8(ascii: "Z"), UInt8(ascii: "z")) {
            // UTC
        } else if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
            let sign = bytes[index] == UInt8(ascii: "-") ? -1 : 1
            index += 1
            guard let offsetHour = digits(2) else { return nil }
            _ = skip(UInt8(ascii: ":"))
            guard let offsetMinute = digits(2), offsetHour < 24, offsetMinute < 60 else { return nil }
            offsetSeconds = sign * (offsetHour * 3600 + offsetMinute * 60)
        } else {
            return nil
        }
        guard index == bytes.count else { return nil }

        let localSeconds = DayKey(year: year, month: month, day: day).epochDay * 86_400 + hour * 3600 + minute * 60 + second
        let milliseconds = (localSeconds - offsetSeconds) * 1000 + fractionMilliseconds
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    }
}
