/// Period bounds and day scheduling for habits, mirroring `api/yawmi/domain/periods.py` (the
/// reference) and `web/src/domain/periods.ts`. Pure functions on `DayKey`s: the local day is
/// computed elsewhere (`DayBoundary.dayKey(for:timeZone:)`), and the loops here count whole days
/// as `DayKey.epochDay` ordinals on the proleptic Gregorian calendar, with no time zone.

/// Inclusive start and end of a habit period.
public struct PeriodBounds: Hashable, Sendable {
    public let start: DayKey
    public let end: DayKey

    public init(start: DayKey, end: DayKey) {
        self.start = start
        self.end = end
    }
}

/// Inputs the habit rules refuse, as the reference raises `ValueError` for them.
public enum HabitRuleError: Error, Hashable, Sendable, CustomStringConvertible {
    /// The spec breaks one of the rules `HabitSpec.validate()` lists; the text names which.
    case invalidSpec(String)
    /// A challenge must last at least one day.
    case invalidDuration(Int)
    /// `goalPrefill` got a goal or a current value that is NaN or infinite.
    case nonFiniteGoal

    public var description: String {
        switch self {
        case .invalidSpec(let reason): "invalid habit spec: \(reason)"
        case .invalidDuration(let days): "a challenge lasts at least one day, got \(days)"
        case .nonFiniteGoal: "the goal and the current value must be finite numbers"
        }
    }
}

extension HabitSpec {
    /// Throws for a spec the reference `HabitSpec` refuses to construct:
    /// - a weekly or monthly habit not scheduled every day;
    /// - a target that is not above zero (NaN included);
    /// - `.weekdays` without a mask in 1...127;
    /// - `.everyNDays` without `everyN >= 2` and an anchor day;
    /// - an end day before the start day;
    /// - an abstain habit that is not a daily boolean with target 1 (rulesVersion 2).
    ///
    /// Every rule that takes a spec calls this first, so an invalid spec never reaches the maths
    /// (a zero `everyN` would otherwise trap on the remainder).
    public func validate() throws(HabitRuleError) {
        if period != .day && scheduleKind != .everyDay {
            throw .invalidSpec("weekly and monthly habits are scheduled every day only")
        }
        if !(targetPerPeriod > 0) {
            throw .invalidSpec("the target per period must be above zero")
        }
        if scheduleKind == .weekdays, !(1...127).contains(weekdayMask ?? 0) {
            throw .invalidSpec("a weekdays schedule needs a mask between 1 and 127")
        }
        if scheduleKind == .everyNDays, (everyN ?? 0) < 2 || anchorDay == nil {
            throw .invalidSpec("an every-n-days schedule needs n >= 2 and an anchor day")
        }
        if let endDay, endDay < startDay {
            throw .invalidSpec("the end day is before the start day")
        }
        if polarity == .abstain, kind != .boolean || period != .day || targetPerPeriod != 1 {
            throw .invalidSpec("an abstain habit is a daily boolean with target 1")
        }
    }
}

extension HabitRules {
    /// Start and end (inclusive) of the period that contains `day`:
    /// - `.day`: the day itself.
    /// - `.week`: seven days from the latest day matching `weekStart`.
    /// - `.month`: the Gregorian month (a leap February has 29 days).
    public static func periodBounds(containing day: DayKey, period: HabitPeriod, weekStart: WeekStart) -> PeriodBounds {
        let bounds = periodBounds(day.epochDay, period, weekStart)
        return PeriodBounds(start: DayKey(epochDay: bounds.start), end: DayKey(epochDay: bounds.end))
    }

    /// Whether `day` is scheduled for the habit. Days outside `[startDay, endDay]` never are.
    /// Inside: `.everyDay` always; `.weekdays` when the day's bit is set in `weekdayMask`
    /// (bit 0 = Sunday ... bit 6 = Saturday); `.everyNDays` when `(day − anchorDay) mod everyN == 0`,
    /// the anchor lying before or after the start.
    public static func isScheduled(_ day: DayKey, for spec: HabitSpec) throws(HabitRuleError) -> Bool {
        try Schedule(spec).contains(day.epochDay)
    }

    /// The last day of a challenge lasting `durationDays` days from `start`: start + duration − 1.
    public static func endDay(start: DayKey, durationDays: Int) throws(HabitRuleError) -> DayKey {
        guard durationDays >= 1 else { throw .invalidDuration(durationDays) }
        return DayKey(epochDay: start.epochDay + durationDays - 1)
    }

    /// Inclusive bounds, as epoch-day ordinals, of the period that contains the ordinal `day`.
    static func periodBounds(_ day: Int, _ period: HabitPeriod, _ weekStart: WeekStart) -> (start: Int, end: Int) {
        switch period {
        case .day:
            return (day, day)
        case .week:
            let start = day - floorModulo(weekday(day) - weekStart.weekday, 7)
            return (start, start + 6)
        case .month:
            let key = DayKey(epochDay: day)
            let start = day - key.day + 1
            return (start, start + daysInMonth(year: key.year, month: key.month) - 1)
        }
    }
}

/// A validated habit's window and schedule as epoch-day ordinals, built once for the rule loops.
struct Schedule {
    let start: Int
    /// `nil` for an open habit.
    let end: Int?
    let kind: ScheduleKind
    let mask: Int
    let everyN: Int
    let anchor: Int

    init(_ spec: HabitSpec) throws(HabitRuleError) {
        try spec.validate()
        start = spec.startDay.epochDay
        end = spec.endDay?.epochDay
        kind = spec.scheduleKind
        mask = spec.weekdayMask ?? 0
        everyN = spec.everyN ?? 1
        anchor = spec.anchorDay?.epochDay ?? 0
    }

    /// The last day of the window, `Int.max` for an open habit (only ever compared, never added to).
    var last: Int { end ?? Int.max }

    func contains(_ day: Int) -> Bool {
        guard day >= start, day <= last else { return false }
        switch kind {
        case .everyDay: return true
        case .weekdays: return mask & (1 << weekday(day)) != 0
        case .everyNDays: return floorModulo(day - anchor, everyN) == 0
        }
    }

    /// The scheduled days of `[from, to]`, in order.
    func days(from: Int, to: Int) -> [Int] {
        from > to ? [] : (from...to).filter(contains)
    }
}

extension WeekStart {
    /// The day of the week this start names: 0 = Sunday ... 6 = Saturday.
    var weekday: Int {
        switch self {
        case .sun: 0
        case .mon: 1
        case .sat: 6
        }
    }
}

/// The day of the week of an epoch-day ordinal: 0 = Sunday ... 6 = Saturday, the bit numbering of
/// `weekdayMask`. 1970-01-01 was a Thursday.
func weekday(_ epochDay: Int) -> Int {
    floorModulo(epochDay + 4, 7)
}

/// The remainder of `value / divisor` with the sign of `divisor` (Python's `%`).
func floorModulo(_ value: Int, _ divisor: Int) -> Int {
    let remainder = value % divisor
    return remainder != 0 && (remainder < 0) != (divisor < 0) ? remainder + divisor : remainder
}

func daysInMonth(year: Int, month: Int) -> Int {
    switch month {
    case 2: DayKey.isValid(year: year, month: 2, day: 29) ? 29 : 28
    case 4, 6, 9, 11: 30
    default: 31
    }
}
