import Domain
import Foundation
import Testing

/// What the shared vectors leave to each client (their README, "ما لا تغطيه المتجهات"): the inputs
/// the reference refuses with `ValueError`, and a few edges of the Swift port itself.
struct RuleInputTests {
    private static let start = DayKey(year: 2026, month: 11, day: 1)
    private static let today = DayKey(year: 2026, month: 11, day: 20)

    private static func habit(
        period: HabitPeriod = .day,
        schedule: ScheduleKind = .everyDay,
        target: Double = 1,
        mask: Int? = nil,
        everyN: Int? = nil,
        anchor: DayKey? = nil,
        end: DayKey? = nil
    ) -> HabitSpec {
        HabitSpec(
            kind: .count, unit: nil, targetPerPeriod: target, period: period, scheduleKind: schedule,
            weekdayMask: mask, everyN: everyN, anchorDay: anchor, startDay: start, endDay: end
        )
    }

    static let invalidSpecs: [HabitSpec] = [
        habit(period: .week, schedule: .weekdays, mask: 1),
        habit(period: .month, schedule: .everyNDays, everyN: 2, anchor: start),
        habit(target: 0),
        habit(target: -1),
        habit(target: .nan),
        habit(schedule: .weekdays),
        habit(schedule: .weekdays, mask: 0),
        habit(schedule: .weekdays, mask: 128),
        habit(schedule: .everyNDays, everyN: 1, anchor: start),
        habit(schedule: .everyNDays, everyN: 0, anchor: start),
        habit(schedule: .everyNDays, everyN: 3),
        habit(end: DayKey(year: 2026, month: 10, day: 31)),
    ]

    @Test(arguments: invalidSpecs)
    func everyRuleRefusesASpecTheReferenceRefuses(_ spec: HabitSpec) {
        #expect(throws: HabitRuleError.self) { try spec.validate() }
        #expect(throws: HabitRuleError.self) { try HabitRules.isScheduled(Self.today, for: spec) }
        #expect(throws: HabitRuleError.self) {
            try HabitRules.periodProgress(spec, logs: [], today: Self.today, weekStart: .sun)
        }
        #expect(throws: HabitRuleError.self) { try HabitRules.strength(spec, logs: [], today: Self.today, weekStart: .sun) }
        #expect(throws: HabitRuleError.self) { try HabitRules.streak(spec, logs: [], today: Self.today, weekStart: .sun) }
        #expect(throws: HabitRuleError.self) { try HabitRules.challengeProgress(spec, logs: [], today: Self.today) }
        #expect(throws: HabitRuleError.self) { try HabitRules.adherence(spec, logs: [], today: Self.today, weekStart: .sun) }
    }

    @Test
    func validSpecsOfEveryScheduleAreAccepted() throws {
        try Self.habit().validate()
        try Self.habit(period: .week).validate()
        try Self.habit(schedule: .weekdays, mask: 127).validate()
        try Self.habit(schedule: .everyNDays, everyN: 2, anchor: DayKey(year: 2030, month: 1, day: 1)).validate()
        try Self.habit(end: Self.start).validate()
        try Self.habit(target: .infinity).validate()  // `not inf > 0` is False in the reference too
    }

    @Test(arguments: [0, -1, Int.min])
    func aChallengeLastsAtLeastOneDay(_ days: Int) {
        #expect(throws: HabitRuleError.invalidDuration(days)) {
            try HabitRules.endDay(start: Self.start, durationDays: days)
        }
    }

    @Test(arguments: [(Double.nan, 0.0), (.infinity, 0), (0, .infinity), (.infinity, .infinity), (1e300, -1e300)])
    func goalPrefillRefusesANonFiniteOrHugeGoal(_ goal: Double, _ current: Double) {
        #expect(throws: HabitRuleError.nonFiniteGoal) {
            try HabitRules.goalPrefill(
                goalTarget: goal, current: current, today: Self.start, deadline: Self.today, period: .day, weekStart: .sun
            )
        }
    }

    @Test
    func anOpenHabitHasNoChallengeProgress() throws {
        #expect(try HabitRules.challengeProgress(Self.habit(), logs: [], today: Self.today) == nil)
    }

    @Test
    func aMissedLogMarksTheDayAsLoggedForStrength() throws {
        // today joins strength when it has any log, `missed` included (setdefault in the reference)
        let spec = Self.habit()
        let done = (0..<19).map { HabitLog(day: DayKey(epochDay: Self.start.epochDay + $0), value: 1, status: .done) }
        let withoutToday = try HabitRules.strength(spec, logs: done, today: Self.today, weekStart: .sun)
        let missed = done + [HabitLog(day: Self.today, value: nil, status: .missed)]
        let withMissedToday = try HabitRules.strength(spec, logs: missed, today: Self.today, weekStart: .sun)
        #expect(withMissedToday < withoutToday)
    }

    // MARK: Scores

    @Test
    func scoresRefuseNonFiniteInputs() {
        for bad in [Double.nan, .infinity, -.infinity] {
            #expect(throws: ScoreError.self) { try Scores.recovery(zHRV: bad, zRHR: 0, zSleep: 0) }
            #expect(throws: ScoreError.self) { try Scores.recovery(zHRV: 0, zRHR: 0, zSleep: 0, penalty: bad) }
            #expect(throws: ScoreError.self) { try Scores.trimp(minutes: bad, hrReserve: 0.5) }
            #expect(throws: ScoreError.self) { try Scores.trimp(minutes: 10, hrReserve: bad) }
            #expect(throws: ScoreError.self) { try Scores.strain(trimpTotal: bad) }
            #expect(throws: ScoreError.self) {
                try Scores.zscore(bad, baseline: Baseline(mean: 0, sd: 1, n: 7, quality: .provisional))
            }
        }
    }

    private static func nights(_ values: [Double], before day: DayKey) -> [(day: DayKey, value: Double)] {
        values.enumerated().map { (DayKey(epochDay: day.epochDay - 1 - $0.offset), $0.element) }
    }

    @Test
    func baselineChecksValuesOnlyOnceTheWindowHasEnoughNights() throws {
        // the reference returns None before it looks at the values
        #expect(try Scores.baseline(nights: Self.nights([.nan], before: Self.today), day: Self.today) == nil)
        let seven = Self.nights([60, 61, 62, 63, 64, 65, .nan], before: Self.today)
        #expect(throws: ScoreError.nonFinite("value")) { try Scores.baseline(nights: seven, day: Self.today) }
        let zero = Self.nights([60, 61, 62, 63, 64, 65, 0], before: Self.today)
        #expect(throws: ScoreError.notPositiveForLog) { try Scores.baseline(nights: zero, day: Self.today, log: true) }
        #expect(try Scores.baseline(nights: zero, day: Self.today)?.n == 7)
    }

    @Test
    func zscoreOnTheLogScaleAndWithoutSpread() throws {
        let flat = Baseline(mean: 4, sd: 0, n: 7, quality: .full)
        #expect(try Scores.zscore(100, baseline: flat) == 0)
        #expect(throws: ScoreError.notPositiveForLog) { try Scores.zscore(0, baseline: flat, log: true) }
        let spread = Baseline(mean: log(50), sd: 0.5, n: 28, quality: .full)
        #expect(abs(try Scores.zscore(50 * exp(1), baseline: spread, log: true) - 2) < 1e-12)
    }

    @Test
    func aRepeatedNightCountsOnceForQuality() {
        let day = Self.today
        let sixDays = (1...6).map { DayKey(epochDay: day.epochDay - $0) }
        #expect(Scores.baselineQuality(nights: sixDays + [sixDays[0]], day: day) == nil)
        #expect(Scores.baselineQuality(nights: sixDays + [DayKey(epochDay: day.epochDay - 7)], day: day) == .provisional)
    }

    @Test
    func recoveryClipsAHugePenaltyWithoutTrapping() throws {
        #expect(try Scores.recovery(zHRV: 0, zRHR: 0, zSleep: 0, penalty: -1e300) == 100)
        #expect(try Scores.recovery(zHRV: 0, zRHR: 0, zSleep: 0, penalty: 1e300) == 0)
        #expect(try Scores.recovery(zHRV: 0, zRHR: 0, zSleep: 0) == 50)
    }

    @Test
    func dataQualityBranches() {
        #expect(Scores.dataQuality(hasWatchNight: false, hrvSamples: 10) == .missing)
        #expect(Scores.dataQuality(hasWatchNight: true, hrvSamples: 2) == .low)
        #expect(Scores.dataQuality(hasWatchNight: true, hrvSamples: 3) == .ok)
    }

    @Test
    func theWindowIsTheTwentyEightDaysBefore() {
        let window = Scores.baselineWindow(for: DayKey(year: 2026, month: 3, day: 1))
        #expect(window.lowerBound == DayKey(year: 2026, month: 2, day: 1))
        #expect(window.upperBound == DayKey(year: 2026, month: 2, day: 28))
    }
}
