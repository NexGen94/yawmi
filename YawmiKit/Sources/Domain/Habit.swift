/// Habit model types, mirroring `api/yawmi/domain/habits.py` and `periods.py`: same names, same
/// raw values, `snake_case` keys on the wire (the shared domain vectors use them too).

public enum HabitKind: String, Codable, Sendable, Hashable, CaseIterable {
    case boolean, count, duration
}

public enum HabitUnit: String, Codable, Sendable, Hashable, CaseIterable {
    case session, min, hour
}

public enum HabitPeriod: String, Codable, Sendable, Hashable, CaseIterable {
    case day, week, month
}

public enum ScheduleKind: String, Codable, Sendable, Hashable, CaseIterable {
    case everyDay = "every_day"
    case weekdays
    case everyNDays = "every_n_days"
}

/// The day a week starts on. The app uses `sun` (D-061).
public enum WeekStart: String, Codable, Sendable, Hashable, CaseIterable {
    case sat, sun, mon
}

public enum HabitLogStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case done, skip, vacation, missed
}

/// rulesVersion 2 (design 9.6): `abstain` is a daily boolean habit with target 1 whose `done` log
/// is a slip; every scheduled day up to and including today is kept unless a slip is logged.
public enum HabitPolarity: String, Codable, Sendable, Hashable, CaseIterable {
    case build, abstain
}

/// A habit as the rules need it (the columns of `yawmi.habits` that matter for the maths).
///
/// - `targetPerPeriod` is in the habit's unit and greater than zero.
/// - `weekdayMask`: bit 0 = Sunday ... bit 6 = Saturday; required for `.weekdays` (1...127).
/// - `everyN` and `anchorDay`: required for `.everyNDays`.
/// - `endDay`: the last day of a challenge with an end, `nil` for an open habit.
/// - Weekly and monthly habits take `.everyDay` scheduling only.
/// - `polarity`: `.build` (the default, and what a missing key decodes to) or `.abstain`, which
///   must be a daily boolean with target 1.
///
/// Unlike the Python reference this type does not validate on construction: invalid specs are
/// rejected by the server, and the rules treat the vectors' inputs as already valid.
public struct HabitSpec: Codable, Sendable, Hashable {
    public var kind: HabitKind
    public var unit: HabitUnit?
    public var targetPerPeriod: Double
    public var period: HabitPeriod
    public var scheduleKind: ScheduleKind
    public var weekdayMask: Int?
    public var everyN: Int?
    public var anchorDay: DayKey?
    public var startDay: DayKey
    public var endDay: DayKey?
    public var polarity: HabitPolarity

    public init(
        kind: HabitKind,
        unit: HabitUnit?,
        targetPerPeriod: Double,
        period: HabitPeriod,
        scheduleKind: ScheduleKind,
        weekdayMask: Int?,
        everyN: Int?,
        anchorDay: DayKey?,
        startDay: DayKey,
        endDay: DayKey?,
        polarity: HabitPolarity = .build
    ) {
        self.kind = kind
        self.unit = unit
        self.targetPerPeriod = targetPerPeriod
        self.period = period
        self.scheduleKind = scheduleKind
        self.weekdayMask = weekdayMask
        self.everyN = everyN
        self.anchorDay = anchorDay
        self.startDay = startDay
        self.endDay = endDay
        self.polarity = polarity
    }

    private enum CodingKeys: String, CodingKey {
        case kind, unit, period, polarity
        case targetPerPeriod = "target_per_period"
        case scheduleKind = "schedule_kind"
        case weekdayMask = "weekday_mask"
        case everyN = "every_n"
        case anchorDay = "anchor_day"
        case startDay = "start_day"
        case endDay = "end_day"
    }

    /// Decodes both shapes in use: the vectors write a habit without a unit as `"unit": null`,
    /// the API (`HabitOut.unit` in `openapi/openapi.json`) as `"unit": ""`. Both become `nil`.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let unitText = try container.decodeIfPresent(String.self, forKey: .unit)
        let unit: HabitUnit?
        switch unitText {
        case nil, "":
            unit = nil
        case let text?:
            guard let known = HabitUnit(rawValue: text) else {
                throw DecodingError.dataCorruptedError(forKey: .unit, in: container, debugDescription: "Unknown unit \"\(text)\"")
            }
            unit = known
        }
        self.init(
            kind: try container.decode(HabitKind.self, forKey: .kind),
            unit: unit,
            targetPerPeriod: try container.decode(Double.self, forKey: .targetPerPeriod),
            period: try container.decode(HabitPeriod.self, forKey: .period),
            scheduleKind: try container.decode(ScheduleKind.self, forKey: .scheduleKind),
            weekdayMask: try container.decodeIfPresent(Int.self, forKey: .weekdayMask),
            everyN: try container.decodeIfPresent(Int.self, forKey: .everyN),
            anchorDay: try container.decodeIfPresent(DayKey.self, forKey: .anchorDay),
            startDay: try container.decode(DayKey.self, forKey: .startDay),
            endDay: try container.decodeIfPresent(DayKey.self, forKey: .endDay),
            polarity: try container.decodeIfPresent(HabitPolarity.self, forKey: .polarity) ?? .build
        )
    }
}

/// One day's log entry: `value` is the amount done (ignored unless `status == .done`).
///
/// Stored data holds one log per habit and day whatever the device: the newest event wins
/// (owner ruling I-10, `habit_logs` keyed on `(habit_code, day)`). The rules still accept several
/// logs for a day and add up their `done` values, as the reference does, so a caller that passes
/// several gets the same total on every client.
public struct HabitLog: Codable, Sendable, Hashable {
    public var day: DayKey
    public var value: Double?
    public var status: HabitLogStatus

    public init(day: DayKey, value: Double?, status: HabitLogStatus) {
        self.day = day
        self.value = value
        self.status = status
    }
}
