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
/// - An abstain habit (`polarity == .abstain`, rulesVersion 2, design 9.6) is a daily boolean with
///   target 1 whose `done` log is a slip. Every scheduled day up to and including today is kept
///   (value 1) unless a slip is logged; a slip day is missed (value 0); `skip` and `vacation` stay
///   neutral. `strength`, `streak`, `adherence` and `challengeProgress` at T equal a build habit
///   with `done` on every kept day evaluated at T + 1 (today is settled, never pending);
///   `periodProgress` stays at T: done 1 without a slip, 0 with one, expected 1 either way.
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
        let schedule = try Schedule(spec)
        let now = today.epochDay
        let days = aggregate(spec, schedule, logs, now)
        let (start, end) = periodBounds(now, spec.period, weekStart)
        let target = effectiveTarget(spec, schedule, start, end)
        let done = periodDone(days, start, end)
        let scheduled = schedule.days(from: start, to: end)
        var elapsed = 0
        var remaining = 0
        for day in scheduled {
            if (day < now || (day == now && days[now] != nil)) && !isSkipped(days[day]) { elapsed += 1 }
            if day >= now { remaining += 1 }
        }
        let expected = scheduled.isEmpty ? 0 : target * Double(elapsed) / Double(scheduled.count)
        return PeriodProgress(
            done: done,
            target: target,
            completion: min(1, done / target),
            reached: atLeast(done, target),
            expected: expected,
            onTrack: atLeast(done, expected),
            needPerDay: remaining > 0 ? max(0, target - done) / Double(remaining) : 0
        )
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
        _ = weekStart
        let schedule = try Schedule(spec)
        let days = aggregate(spec, schedule, logs, today.epochDay)
        let now = settled(spec, today.epochDay)
        let last = min(days[now] != nil ? now : now - 1, schedule.last)
        let target = spec.targetPerPeriod
        let window = rollingWindowDays(spec.period)
        let frequency = spec.period == .day || spec.kind == .duration ? 1 : min(1, target / Double(window))
        let keep = pow(0.5, frequency.squareRoot() / strengthScale)
        var score = 0.0
        if schedule.start <= last {
            for day in schedule.start...last where schedule.contains(day) && !isSkipped(days[day]) {
                let value = spec.period == .day ? days[day]?.done ?? 0 : periodDone(days, day - window + 1, day)
                score = score * keep + min(1, value / target) * (1 - keep)
            }
        }
        return min(1, max(0, score))
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
        let schedule = try Schedule(spec)
        let now = settled(spec, today.epochDay)
        if now < schedule.start { return 0 }
        let days = aggregate(spec, schedule, logs, today.epochDay)
        let inProgress = now <= schedule.last
        let firstStart = periodBounds(schedule.start, spec.period, weekStart).start
        var (start, end) = periodBounds(inProgress ? now : schedule.last, spec.period, weekStart)
        var count = 0
        var current = inProgress
        while true {
            let state = periodState(spec, schedule, days, start, end)
            if state == .reached {
                count += 1
            } else if state == .missed && !current {
                break
            }
            if start <= firstStart { break }
            (start, end) = periodBounds(start - 1, spec.period, weekStart)
            current = false
        }
        return count
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
        let schedule = try Schedule(spec)
        guard let last = schedule.end else { return nil }
        let days = aggregate(spec, schedule, logs, today.epochDay)
        let now = settled(spec, today.epochDay)
        var achieved = 0
        var total = 0
        if spec.period == .day {
            for day in schedule.days(from: schedule.start, to: last) {
                total += 1
                if let value = days[day], atLeast(value.done, spec.targetPerPeriod) { achieved += 1 }
            }
        } else {
            var (start, end) = periodBounds(schedule.start, spec.period, weekStart)
            while start <= last {
                total += 1
                if atLeast(periodDone(days, start, end), effectiveTarget(spec, schedule, start, end)) {
                    achieved += 1
                }
                (start, end) = periodBounds(end + 1, spec.period, weekStart)
            }
        }
        return ChallengeProgress(
            achieved: achieved,
            total: total,
            completion: total > 0 ? Double(achieved) / Double(total) : 0,
            remainingDays: max(0, last - max(now, schedule.start) + 1)
        )
    }

    // MARK: Adherence

    /// Finished periods reached / finished periods that are not neutral; `nil` when no such period
    /// has finished. A period finishes when its last day (clipped at `endDay`) is before `today`.
    public static func adherence(
        _ spec: HabitSpec, logs: [HabitLog], today: DayKey, weekStart: WeekStart
    ) throws(HabitRuleError) -> Double? {
        let schedule = try Schedule(spec)
        let days = aggregate(spec, schedule, logs, today.epochDay)
        let now = settled(spec, today.epochDay)
        var (start, end) = periodBounds(schedule.start, spec.period, weekStart)
        var reached = 0
        var counted = 0
        while start <= schedule.last && min(end, schedule.last) < now {
            let state = periodState(spec, schedule, days, start, end)
            if state == .reached { reached += 1 }
            if state != .neutral { counted += 1 }
            (start, end) = periodBounds(end + 1, spec.period, weekStart)
        }
        return counted > 0 ? Double(reached) / Double(counted) : nil
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
        let first = periodBounds(today.epochDay, period, weekStart).start
        let last = periodBounds(deadline.epochDay, period, weekStart).start
        let periods: Int
        switch period {
        case .day:
            periods = last - first + 1
        case .week:
            periods = floorDivide(last - first, 7) + 1
        case .month:
            let from = DayKey(epochDay: first)
            let to = DayKey(epochDay: last)
            periods = (to.year - from.year) * 12 + to.month - from.month + 1
        }
        let perPeriod = (goalTarget - current) / Double(max(1, periods)) - epsilon
        // the bound keeps `Int(_:)` from trapping; no real goal comes near it
        guard perPeriod.isFinite, abs(perPeriod) < 9e15 else { throw .nonFiniteGoal }
        return max(1, Int(perPeriod.rounded(.up)))
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
        return spec.polarity == .abstain ? abstainDays(schedule, days, today) : days
    }

    /// An abstain habit's days as its build twin sees them (design 9.6), over
    /// `[startDay, min(today, endDay)]`: a slip day stays, missed with value 0 and an entry (so it
    /// enters today's `expected`); a `skip` or `vacation` day without a slip is neutral; every other
    /// scheduled day is kept with value 1. A `missed` log changes nothing: the day is kept unless a
    /// slip is logged.
    static func abstainDays(_ schedule: Schedule, _ logged: [Int: DayTotal], _ today: Int) -> [Int: DayTotal] {
        var days: [Int: DayTotal] = [:]
        let last = min(today, schedule.last)
        guard schedule.start <= last else { return days }
        for day in schedule.start...last {
            if let total = logged[day], total.done > 0 {
                days[day] = DayTotal(done: 0, neutral: total.neutral)
            } else if let total = logged[day], total.neutral {
                days[day] = DayTotal(done: 0, neutral: true)
            } else if schedule.contains(day) {
                days[day] = DayTotal(done: 1, neutral: false)
            }
        }
        return days
    }

    /// The day the cumulative rules judge at: T + 1 for an abstain habit (today is settled), else T.
    static func settled(_ spec: HabitSpec, _ today: Int) -> Int {
        spec.polarity == .abstain ? today + 1 : today
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
