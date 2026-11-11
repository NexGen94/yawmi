import Foundation

/// A payload the server validates and projects into a table, mirroring the payload models in
/// `api/yawmi/events/project.py`: the same `snake_case` keys, optional fields left out when `nil`,
/// days as `YYYY-MM-DD` and instants as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
///
/// The server ignores fields it does not know, and so does decoding here. The value ranges (for
/// example `value` from 0 to 1,000,000, `focus_rating` from 1 to 5) are enforced by the server,
/// which answers 422 for a payload outside them, and refuses the whole batch with it.
///
/// The decimal scale is the exception, because arithmetic produces it (`1471.0 / 60`,
/// `0.1 + 0.2`): the fractional fields round themselves to the server's scale when set,
/// initialised or decoded, so what a payload holds is exactly what goes on the wire.
public protocol EventPayload: Codable, Sendable, Hashable {
    /// The event type that carries this payload.
    static var eventType: EventType { get }
}

/// Rounding to the decimal places a server `Decimal` field accepts (`decimal_places` in
/// `api/yawmi/events/project.py`).
enum DecimalScale {
    /// `Quantity` (`value`) and `Minutes` (`actual_minutes`).
    static let quantity = 4
    /// `breaths_per_min`.
    static let rate = 3

    /// `value` rounded half away from zero to `places` decimals. The result is an integer divided
    /// by a power of ten, both exact in a `Double` for every value the server accepts, so the
    /// division gives the double nearest that decimal, and its shortest text (what JSON gets) has
    /// at most `places` decimals. Non-finite values are returned unchanged (encoding refuses them).
    static func round(_ value: Double?, places: Int) -> Double? {
        guard let value, value.isFinite else { return value }
        let scale = pow(10.0, Double(places))
        let scaled = (value * scale).rounded()
        guard abs(scaled) < 9_007_199_254_740_992 else { return value }  // 2^53: already whole
        return scaled / scale
    }
}

extension EventPayload {
    /// The payload as the JSON object an `EventEnvelope` carries.
    public func jsonObject() throws -> [String: JSONValue] {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601Instant.format(date))
        }
        return try JSONDecoder().decode([String: JSONValue].self, from: encoder.encode(self))
    }

    /// The payload read from an envelope's JSON object.
    public init(jsonObject: [String: JSONValue]) throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = ISO8601Instant.parse(text) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Not an ISO 8601 instant with a UTC offset: \"\(text)\""
                )
            }
            return date
        }
        self = try decoder.decode(Self.self, from: JSONEncoder().encode(jsonObject))
    }
}

/// `habit_logged`: `{habit_code, status: done|skip|vacation, day?, value?}`.
///
/// `day` defaults to the local day of the event (in its `tz`) and may be back-dated by at most
/// seven days from that day, never forward. The server keeps `value` only for `done`, and keeps
/// one log per habit and day: the event with the newest `occurred_at` wins, whatever the device
/// (owner ruling I-10).
public struct HabitLoggedPayload: EventPayload {
    public static let eventType = EventType.habitLogged

    /// `missed` exists in `habit_logs` but only the server writes it, so a client cannot send it.
    public enum Status: String, Codable, Sendable, Hashable, CaseIterable {
        case done, skip, vacation
    }

    public var habitCode: String
    public var status: Status
    public var day: DayKey?
    /// Rounded to four decimals, the server's scale (`Quantity`).
    public var value: Double? {
        didSet { value = DecimalScale.round(value, places: DecimalScale.quantity) }
    }

    public init(habitCode: String, status: Status, day: DayKey? = nil, value: Double? = nil) {
        self.habitCode = habitCode
        self.status = status
        self.day = day
        self.value = DecimalScale.round(value, places: DecimalScale.quantity)
    }

    private enum CodingKeys: String, CodingKey {
        case status, day, value
        case habitCode = "habit_code"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            habitCode: try container.decode(String.self, forKey: .habitCode),
            status: try container.decode(Status.self, forKey: .status),
            day: try container.decodeIfPresent(DayKey.self, forKey: .day),
            value: try container.decodeIfPresent(Double.self, forKey: .value)
        )
    }
}

/// `habit_skipped`: `{habit_code, day?}`. The same as a `habit_logged` with `status: skip`.
public struct HabitSkippedPayload: EventPayload {
    public static let eventType = EventType.habitSkipped

    public var habitCode: String
    public var day: DayKey?

    public init(habitCode: String, day: DayKey? = nil) {
        self.habitCode = habitCode
        self.day = day
    }

    private enum CodingKeys: String, CodingKey {
        case day
        case habitCode = "habit_code"
    }
}

/// `habit_vacation`: `{habit_code, day?}`. The same as a `habit_logged` with `status: vacation`.
public struct HabitVacationPayload: EventPayload {
    public static let eventType = EventType.habitVacation

    public var habitCode: String
    public var day: DayKey?

    public init(habitCode: String, day: DayKey? = nil) {
        self.habitCode = habitCode
        self.day = day
    }

    private enum CodingKeys: String, CodingKey {
        case day
        case habitCode = "habit_code"
    }
}

/// `focus_ended`: `{habit_code?, goal_ref?, started_at?, ended_at?, planned_minutes?,
/// actual_minutes?, focus_rating?, next_step?}`.
///
/// A missing `ended_at` is the event's `occurred_at`; a missing `started_at` is the end minus
/// `actual_minutes` (or the end itself). The session is filed under the local day of its start.
public struct FocusEndedPayload: EventPayload {
    public static let eventType = EventType.focusEnded

    public var habitCode: String?
    public var goalRef: String?
    public var startedAt: Date?
    public var endedAt: Date?
    public var plannedMinutes: Int?
    /// Rounded to four decimals, the server's scale (`Minutes`).
    public var actualMinutes: Double? {
        didSet { actualMinutes = DecimalScale.round(actualMinutes, places: DecimalScale.quantity) }
    }
    /// 1 to 5.
    public var focusRating: Int?
    public var nextStep: String?

    public init(
        habitCode: String? = nil,
        goalRef: String? = nil,
        startedAt: Date? = nil,
        endedAt: Date? = nil,
        plannedMinutes: Int? = nil,
        actualMinutes: Double? = nil,
        focusRating: Int? = nil,
        nextStep: String? = nil
    ) {
        self.habitCode = habitCode
        self.goalRef = goalRef
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.plannedMinutes = plannedMinutes
        self.actualMinutes = DecimalScale.round(actualMinutes, places: DecimalScale.quantity)
        self.focusRating = focusRating
        self.nextStep = nextStep
    }

    private enum CodingKeys: String, CodingKey {
        case habitCode = "habit_code"
        case goalRef = "goal_ref"
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case plannedMinutes = "planned_minutes"
        case actualMinutes = "actual_minutes"
        case focusRating = "focus_rating"
        case nextStep = "next_step"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            habitCode: try container.decodeIfPresent(String.self, forKey: .habitCode),
            goalRef: try container.decodeIfPresent(String.self, forKey: .goalRef),
            startedAt: try container.decodeIfPresent(Date.self, forKey: .startedAt),
            endedAt: try container.decodeIfPresent(Date.self, forKey: .endedAt),
            plannedMinutes: try container.decodeIfPresent(Int.self, forKey: .plannedMinutes),
            actualMinutes: try container.decodeIfPresent(Double.self, forKey: .actualMinutes),
            focusRating: try container.decodeIfPresent(Int.self, forKey: .focusRating),
            nextStep: try container.decodeIfPresent(String.self, forKey: .nextStep)
        )
    }
}

/// `breath_ended`: `{pattern, started_at?, ended_at?, breaths_per_min?, duration_seconds?,
/// completed?}`. `completed` defaults to `true`, as the column does.
///
/// The session bounds follow the same rule as `focus_ended`, with `duration_seconds` as the span.
public struct BreathEndedPayload: EventPayload {
    public static let eventType = EventType.breathEnded

    public var pattern: String
    public var startedAt: Date?
    public var endedAt: Date?
    /// Rounded to three decimals, the server's scale for `breaths_per_min`.
    public var breathsPerMin: Double? {
        didSet { breathsPerMin = DecimalScale.round(breathsPerMin, places: DecimalScale.rate) }
    }
    public var durationSeconds: Int?
    public var completed: Bool

    public init(
        pattern: String,
        startedAt: Date? = nil,
        endedAt: Date? = nil,
        breathsPerMin: Double? = nil,
        durationSeconds: Int? = nil,
        completed: Bool = true
    ) {
        self.pattern = pattern
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.breathsPerMin = DecimalScale.round(breathsPerMin, places: DecimalScale.rate)
        self.durationSeconds = durationSeconds
        self.completed = completed
    }

    private enum CodingKeys: String, CodingKey {
        case pattern, completed
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case breathsPerMin = "breaths_per_min"
        case durationSeconds = "duration_seconds"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            pattern: try container.decode(String.self, forKey: .pattern),
            startedAt: try container.decodeIfPresent(Date.self, forKey: .startedAt),
            endedAt: try container.decodeIfPresent(Date.self, forKey: .endedAt),
            breathsPerMin: try container.decodeIfPresent(Double.self, forKey: .breathsPerMin),
            durationSeconds: try container.decodeIfPresent(Int.self, forKey: .durationSeconds),
            completed: try container.decodeIfPresent(Bool.self, forKey: .completed) ?? true
        )
    }
}
