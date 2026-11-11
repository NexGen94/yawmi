import Foundation

/// Pure habit rules: `periodBounds`, `isScheduled`, `endDay` (in `Periods.swift`),
/// `periodProgress`, `strength`, `streak`, `challengeProgress`, `adherence` and `goalPrefill`.
///
/// A line-by-line port of `api/yawmi/domain/habits.py`, which is the authority; the shared vectors
/// in `contracts/domain-vectors/v1` prove Python, TypeScript and Swift agree. Do not change a rule
/// here without changing the reference first.
///
/// Rules common to every function (pinned by the vectors):
/// - Logs outside `[startDay, endDay]` or after `today` are ignored. Logs are sorted (day, then
///   value with `nil` as −1, then status) before they are summed, so the input order cannot change
///   even the last digit of a result.
/// - A day's value is the sum of its `done` values. For a boolean habit one or more `done` logs
///   mean 1 (capped at 1 a day); for the others a `done` without a value counts 0. Stored data has
///   one log per habit and day (the newest wins, ruling I-10); the sum keeps the rule total for a
///   caller that passes several.
/// - A day is "skipped" when it has a `skip` or `vacation` log and no positive progress. Skipped
///   and unscheduled days are neutral: they never lower strength, break a streak or raise what is
///   due.
/// - A weekly or monthly period clipped by `startDay` or `endDay` has the proportional target
///   `min(T, max(1, ceil(T · k / L − 1e-9)))`, k its scheduled days and L the full period's days
///   (7, or the month's length). A daily period is never proportional.
/// - `done ≥ target` and `done ≥ expected` allow a 1e-9 margin for floating-point noise.
///
/// How exact the floats are: the sums over days use the compensated (Neumaier) summation of
/// Python 3.12+ `sum()`, in the same order, so a period's `done` is bit-identical to the reference
/// (ten logs of 0.1 give exactly 1). A day's own total is a plain `+=` in both. The other
/// operations are IEEE 754 divisions and products in the reference's order, except strength's
/// `0.5 ** x`, where the platform's `pow` may differ from the reference's in the last bit. So
/// integers, booleans and `nil`s are identical, and a fraction is within a few ulps (the vectors
/// allow 1e-9). Decide with `reached` and `onTrack`, not `==` on fractions.
public enum HabitRules {
    /// The margin of `≥` comparisons and of the `ceil` in proportional targets.
    static let epsilon = 1e-9
    /// Strength keeps `m = 0.5 ** (sqrt(f) / 13)` a day; at f = 1, 30 days in a row give ≈ 0.798.
    static let strengthScale = 13.0

    // MARK: Period progress

    /// Progress of the period that contains `today`.
    ///
    /// `expected = target · e / L`: e the scheduled days before today that are not skipped, plus
    /// today only if it has a log (no expectation in the morning before logging), L all scheduled
    /// days of the period; `onTrack = done ≥ expected`. `needPerDay` spreads what is left over the
    /// scheduled days that remain, today always included. A period with no scheduled day expects
    /// nothing.
    public static func periodProgress(
        _ spec: HabitSpec, logs: [HabitLog], today: DayKey, weekStart: WeekStart
    ) throws(HabitRuleError) -> PeriodProgress {
        // 21b red stage: no body yet
        return PeriodProgress(done: -1, target: -1, completion: -1, reached: false, expected: -1, onTrack: false, needPerDay: -1)
    }

    // MARK: Strength

    /// Habit strength in [0, 1] (shown × 100): an exponential moving average from `startDay` to
    /// yesterday; today joins only if it has a log, and strength freezes after `endDay`. For each
    /// scheduled day that is not skipped: `s ← s·m + v·(1 − m)`, `m = 0.5 ** (sqrt(f) / 13)`.
    ///
    /// - Daily: f = 1, `v = min(1, the day's value / target)`; a day with no log or `missed` gives 0.
    /// - Weekly and monthly: `v = min(1, sum of the last L days / target)`, L = 7 or 30, and
    ///   `f = min(1, target / L)` for boolean and count, f = 1 for duration. The target is always
    ///   the full one (rolling windows, no proportional periods).
    ///
    /// `weekStart` does not change the result (rolling windows); it stays in the signature so the
    /// rules read alike.
    public static func strength(
        _ spec: HabitSpec, logs: [HabitLog], today: DayKey, weekStart: WeekStart
    ) throws(HabitRuleError) -> Double {
        // 21b red stage: no body yet
        return -1
    }

    // MARK: Streak

    /// Consecutive reached periods up to the current one.
    ///
    /// A missed period breaks the streak; a neutral one (all its scheduled days skipped, or none
    /// scheduled) bridges it without counting. The current period counts if reached and is
    /// otherwise neutral. After `endDay` there is no current period: every period is judged
    /// strictly. Before `startDay` the streak is 0. A clipped weekly or monthly period is judged on
    /// its proportional target.
    public static func streak(
        _ spec: HabitSpec, logs: [HabitLog], today: DayKey, weekStart: WeekStart
    ) throws(HabitRuleError) -> Int {
        // 21b red stage: no body yet
        return -1
    }

    // MARK: Challenge progress

    /// Progress of a challenge (a habit with an `endDay`); `nil` for an open habit.
    /// - Daily: reached scheduled days / scheduled days of the window (skipped days stay counted).
    /// - Otherwise: reached periods / periods meeting the window, the clipped first and last judged
    ///   on their proportional targets.
    /// - `remainingDays`: days left including today; the whole window before it starts, 0 after.
    public static func challengeProgress(
        _ spec: HabitSpec, logs: [HabitLog], today: DayKey, weekStart: WeekStart = .sun
    ) throws(HabitRuleError) -> ChallengeProgress? {
        // 21b red stage: no body yet
        return nil
    }

    // MARK: Adherence

    /// Finished periods reached / finished periods that are not neutral; `nil` when no such period
    /// has finished. A period finishes when its last day (clipped at `endDay`) is before `today`.
    public static func adherence(
        _ spec: HabitSpec, logs: [HabitLog], today: DayKey, weekStart: WeekStart
    ) throws(HabitRuleError) -> Double? {
        // 21b red stage: no body yet
        return -1
    }

    // MARK: Goal prefill

    /// Suggested per-period target for a habit serving a cumulative KPI:
    /// `max(1, ceil((goalTarget − current) / periods − 1e-9))`, periods counted from the current
    /// one to the deadline's, both included (at least one, even past the deadline).
    ///
    /// Only for a KPI that is cumulative over the horizon; which KPI gets which prefill is decided
    /// by the server (`kpi_prefill_kind` in the reference). Throws for a NaN or infinite result, as
    /// the reference raises, and for one too large for `Int`.
    public static func goalPrefill(
        goalTarget: Double, current: Double, today: DayKey, deadline: DayKey,
        period: HabitPeriod, weekStart: WeekStart
    ) throws(HabitRuleError) -> Int {
        // 21b red stage: no body yet
        return -1
    }

    // MARK: Internals

    /// One day's logs, summed. `neutral`: it has a `skip` or `vacation` log.
    struct DayTotal {
        var done = 0.0
        var neutral = false

        var skipped: Bool { neutral && done <= 0 }
    }

    enum PeriodState {
        case reached, neutral, missed
    }

    static func rollingWindowDays(_ period: HabitPeriod) -> Int {
        switch period {
        case .day: 1
        case .week: 7
        case .month: 30
        }
    }

    static func atLeast(_ value: Double, _ bound: Double) -> Bool {
        value >= bound - epsilon
    }

    static func isSkipped(_ total: DayTotal?) -> Bool {
        total?.skipped ?? false
    }

    static func doneValue(_ spec: HabitSpec, _ log: HabitLog) -> Double {
        if spec.kind == .boolean { return 1 }
        return log.value.map { max(0, $0) } ?? 0
    }

    /// The reference's sort key: day, then value (`nil` as −1), then status.
    static func precedes(_ a: HabitLog, _ b: HabitLog) -> Bool {
        if a.day != b.day { return a.day < b.day }
        let valueA = a.value ?? -1
        let valueB = b.value ?? -1
        if valueA != valueB { return valueA < valueB }
        return a.status.rawValue < b.status.rawValue
    }

    /// The logs of the window `[startDay, min(today, endDay)]`, summed by day in a fixed order.
    /// Every log in the window gives its day an entry, `missed` included, as `setdefault` does in
    /// the reference: "today has a log" counts any status.
    static func aggregate(_ spec: HabitSpec, _ schedule: Schedule, _ logs: [HabitLog], _ today: Int) -> [Int: DayTotal] {
        var days: [Int: DayTotal] = [:]
        for log in logs.sorted(by: precedes) {
            let day = log.day.epochDay
            if day < schedule.start || day > today || day > schedule.last { continue }
            var total = days[day] ?? DayTotal()
            switch log.status {
            case .done: total.done += doneValue(spec, log)
            case .skip, .vacation: total.neutral = true
            case .missed: break
            }
            days[day] = total
        }
        if spec.kind == .boolean {
            for (day, total) in days { days[day]?.done = min(1, total.done) }
        }
        return days
    }

    /// The days' totals from `start` to `end`, summed as CPython 3.12+ `sum()` sums floats:
    /// Neumaier's compensated summation, the compensation added at the end only when it is
    /// non-zero and finite.
    static func periodDone(_ days: [Int: DayTotal], _ start: Int, _ end: Int) -> Double {
        var sum = 0.0
        var compensation = 0.0
        var day = start
        while day <= end {
            if let x = days[day]?.done {
                let next = sum + x
                compensation += abs(sum) >= abs(x) ? (sum - next) + x : (x - next) + sum
                sum = next
            }
            day += 1
        }
        return compensation != 0 && compensation.isFinite ? sum + compensation : sum
    }

    /// The target of the period `[start, end]`: the habit's own, except a weekly or monthly
    /// period clipped by the window (k scheduled days of L), which gets
    /// `min(T, max(1, ceil(T·k/L − 1e-9)))`. A period with no scheduled day at all keeps T.
    static func effectiveTarget(_ spec: HabitSpec, _ schedule: Schedule, _ start: Int, _ end: Int) -> Double {
        let target = spec.targetPerPeriod
        if spec.period == .day { return target }
        let full = end - start + 1
        let clipped = schedule.days(from: start, to: end).count
        if clipped == 0 || clipped >= full { return target }
        return min(target, max(1, (target * Double(clipped) / Double(full) - epsilon).rounded(.up)))
    }

    /// Reached; neutral (no scheduled day, or all of them skipped); or missed.
    static func periodState(
        _ spec: HabitSpec, _ schedule: Schedule, _ days: [Int: DayTotal], _ start: Int, _ end: Int
    ) -> PeriodState {
        let scheduled = schedule.days(from: start, to: end)
        if scheduled.isEmpty { return .neutral }
        if atLeast(periodDone(days, start, end), effectiveTarget(spec, schedule, start, end)) { return .reached }
        if scheduled.allSatisfy({ isSkipped(days[$0]) }) { return .neutral }
        return .missed
    }
}

/// Progress of the current period (`period_progress` in the reference).
///
/// - `done`: the sum of the period's `done` values; `completion = min(1, done / target)`.
/// - `target`: the period's effective target: the habit's own, or the proportional one of a
///   clipped weekly or monthly period.
/// - `reached`: `done ≥ target`.
/// - `expected`: what is due by now; `onTrack`: `done ≥ expected`.
/// - `needPerDay`: what is left, spread over the scheduled days that remain, today included.
public struct PeriodProgress: Hashable, Sendable {
    public let done: Double
    public let target: Double
    public let completion: Double
    public let reached: Bool
    public let expected: Double
    public let onTrack: Bool
    public let needPerDay: Double

    public init(
        done: Double, target: Double, completion: Double, reached: Bool,
        expected: Double, onTrack: Bool, needPerDay: Double
    ) {
        self.done = done
        self.target = target
        self.completion = completion
        self.reached = reached
        self.expected = expected
        self.onTrack = onTrack
        self.needPerDay = needPerDay
    }
}

/// Progress of a challenge with an end: `achieved` of `total`, `completion` their ratio, and
/// `remainingDays` including today.
public struct ChallengeProgress: Hashable, Sendable {
    public let achieved: Int
    public let total: Int
    public let completion: Double
    public let remainingDays: Int

    public init(achieved: Int, total: Int, completion: Double, remainingDays: Int) {
        self.achieved = achieved
        self.total = total
        self.completion = completion
        self.remainingDays = remainingDays
    }
}
