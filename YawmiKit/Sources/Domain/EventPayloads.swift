import Foundation

/// A payload the server validates and projects into a table, mirroring the payload models in
/// `api/yawmi/events/project.py`: the same `snake_case` keys, optional fields left out when `nil`,
/// days as `YYYY-MM-DD` and instants as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
///
/// The server ignores fields it does not know, and so does decoding here. The value ranges (for
/// example `value` from 0 to 1,000,000 with at most four decimals, `focus_rating` from 1 to 5) are
/// enforced by the server, which answers 422 for a payload outside them.
public protocol EventPayload: Codable, Sendable, Hashable {
    /// The event type that carries this payload.
    static var eventType: EventType { get }
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
    public var value: Double?

    public init(habitCode: String, status: Status, day: DayKey? = nil, value: Double? = nil) {
        self.habitCode = habitCode
        self.status = status
        self.day = day
        self.value = value
    }

    private enum CodingKeys: String, CodingKey {
        case status, day, value
        case habitCode = "habit_code"
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
    public var actualMinutes: Double?
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
        self.actualMinutes = actualMinutes
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
    public var breathsPerMin: Double?
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
        self.breathsPerMin = breathsPerMin
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
