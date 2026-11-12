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
        // rulesVersion 2: an abstain habit is a daily boolean with target 1 (design 9.6)
        abstain(kind: .count),
        abstain(kind: .duration),
        abstain(period: .week),
        abstain(period: .month),
        abstain(target: 2),
        abstain(target: 0.5),
    ]

    private static func abstain(
        kind: HabitKind = .boolean, period: HabitPeriod = .day, target: Double = 1, end: DayKey? = nil,
        mask: Int? = nil
    ) -> HabitSpec {
        HabitSpec(
            kind: kind, unit: nil, targetPerPeriod: target, period: period,
            scheduleKind: mask == nil ? .everyDay : .weekdays,
            weekdayMask: mask, everyN: nil, anchorDay: nil, startDay: start, endDay: end, polarity: .abstain
        )
    }

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
        try Self.abstain().validate()
        try Self.abstain(end: Self.today).validate()
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

    // MARK: Abstain habits (rulesVersion 2, design 9.6)

    private static func day(_ offset: Int) -> DayKey { DayKey(epochDay: start.epochDay + offset) }

    /// The build twin of an abstain habit: `done` on every kept day up to `today`, `skip` and
    /// `vacation` as they are.
    private static func keptAsBuild(_ spec: HabitSpec, _ logs: [HabitLog], _ today: DayKey) -> [HabitLog] {
        let last = min(today.epochDay, spec.endDay?.epochDay ?? Int.max)
        let marked = Set(logs.filter { $0.status != .missed }.map(\.day.epochDay))
        let kept = stride(from: spec.startDay.epochDay, through: last, by: 1)
            .filter { !marked.contains($0) && ((try? HabitRules.isScheduled(DayKey(epochDay: $0), for: spec)) ?? false) }
            .map { HabitLog(day: DayKey(epochDay: $0), value: 1, status: .done) }
        return kept + logs.filter { $0.status == .skip || $0.status == .vacation }
    }

    static let slipSets: [[HabitLog]] = [
        [HabitLog(day: day(0), value: 1, status: .done)],
        [HabitLog(day: day(29), value: 1, status: .done)],
        [2, 14, 27].map { HabitLog(day: day($0), value: 1, status: .done) },
        [
            HabitLog(day: day(6), value: 1, status: .done),
            HabitLog(day: day(11), value: nil, status: .skip),
            HabitLog(day: day(24), value: nil, status: .vacation),
        ],
    ]

    /// Abstain at T equals its build twin on the kept days at T + 1, for strength, streak,
    /// adherence and challenge progress, from before the start to past the end.
    /// Every day, and Mon, Wed, Fri (mask 42).
    static let masks: [Int?] = [nil, 42]

    @Test(arguments: slipSets, masks)
    func abstainAtTodayEqualsTheBuildTwinTomorrow(_ logs: [HabitLog], _ mask: Int?) throws {
        for end in [Self.day(29), nil] as [DayKey?] {
            let spec = Self.abstain(end: end, mask: mask)
            var twin = spec
            twin.polarity = .build
            for offset in -2..<34 {
                let today = Self.day(offset)
                let tomorrow = Self.day(offset + 1)
                let build = Self.keptAsBuild(spec, logs, today)
                for weekStart in WeekStart.allCases {
                    let at = "\(today) \(weekStart) \(String(describing: end))"
                    #expect(
                        try HabitRules.strength(spec, logs: logs, today: today, weekStart: weekStart)
                            == HabitRules.strength(twin, logs: build, today: tomorrow, weekStart: weekStart), "\(at)")
                    #expect(
                        try HabitRules.streak(spec, logs: logs, today: today, weekStart: weekStart)
                            == HabitRules.streak(twin, logs: build, today: tomorrow, weekStart: weekStart), "\(at)")
                    #expect(
                        try HabitRules.adherence(spec, logs: logs, today: today, weekStart: weekStart)
                            == HabitRules.adherence(twin, logs: build, today: tomorrow, weekStart: weekStart), "\(at)")
                    #expect(
                        try HabitRules.challengeProgress(spec, logs: logs, today: today, weekStart: weekStart)
                            == HabitRules.challengeProgress(twin, logs: build, today: tomorrow, weekStart: weekStart), "\(at)")
                }
            }
        }
    }

    /// Decided behaviours (review I-1): abstain daily from 2026-11-01, today 2026-11-10 (a Tuesday).
    struct Decided: Sendable, CustomTestStringConvertible {
        let name: String
        let mask: Int?
        let logs: [HabitLog]
        let progress: PeriodProgress
        let streak: Int
        let adherence: Double
        let strength: Double

        var testDescription: String { name }
    }

    private static let skipToday = PeriodProgress(
        done: 0, target: 1, completion: 0, reached: false, expected: 0, onTrack: true, needPerDay: 1
    )
    private static let cleanToday = PeriodProgress(
        done: 1, target: 1, completion: 1, reached: true, expected: 1, onTrack: true, needPerDay: 0
    )
    private static let unscheduledToday = PeriodProgress(
        done: 0, target: 1, completion: 0, reached: false, expected: 0, onTrack: true, needPerDay: 0
    )
    private static func entry(_ offset: Int, _ status: HabitLogStatus) -> HabitLog {
        HabitLog(day: day(offset), value: status == .done ? 1 : nil, status: status)
    }

    static let decided: [Decided] = [
        // skip or vacation today is neutral, as for a build habit (controller ruling, fix round 1)
        Decided(name: "skip today", mask: nil, logs: [entry(9, .skip)], progress: skipToday, streak: 9, adherence: 1, strength: 0.381137),
        Decided(name: "vacation today", mask: nil, logs: [entry(9, .vacation)], progress: skipToday, streak: 9, adherence: 1, strength: 0.381137),
        // a missed log is not a slip: the day is kept unless a done log is recorded
        Decided(name: "missed log today", mask: nil, logs: [entry(9, .missed)], progress: cleanToday, streak: 10, adherence: 1, strength: 0.413270),
        // a slip and a skip on one day: the skip makes the day neutral
        Decided(
            name: "slip and skip today", mask: nil, logs: [entry(9, .done), entry(9, .skip)], progress: skipToday,
            streak: 9, adherence: 1, strength: 0.381137
        ),
        // unscheduled days are not kept, and a slip on one changes nothing
        Decided(name: "Mon, Wed, Fri, no logs", mask: 42, logs: [], progress: unscheduledToday, streak: 4, adherence: 1, strength: 0.192067),
        Decided(
            name: "Mon, Wed, Fri, slip on Saturday", mask: 42, logs: [entry(6, .done)], progress: unscheduledToday,
            streak: 4, adherence: 1, strength: 0.192067
        ),
        Decided(
            name: "Mon, Wed, Fri, slip today (Tuesday)", mask: 42, logs: [entry(9, .done)], progress: unscheduledToday,
            streak: 4, adherence: 1, strength: 0.192067
        ),
    ]

    @Test(arguments: decided)
    func abstainDecidedBehaviours(_ item: Decided) throws {
        let spec = Self.abstain(mask: item.mask)
        let today = Self.day(9)
        #expect(try HabitRules.periodProgress(spec, logs: item.logs, today: today, weekStart: .sun) == item.progress)
        #expect(try HabitRules.streak(spec, logs: item.logs, today: today, weekStart: .sun) == item.streak)
        #expect(try HabitRules.adherence(spec, logs: item.logs, today: today, weekStart: .sun) == item.adherence)
        #expect(abs(try HabitRules.strength(spec, logs: item.logs, today: today, weekStart: .sun) - item.strength) <= 1e-6)
    }

    @Test
    func abstainTodayIsKeptUntilASlipIsLogged() throws {
        let today = Self.day(9)
        let clean = try HabitRules.periodProgress(Self.abstain(), logs: [], today: today, weekStart: .sun)
        #expect(clean == PeriodProgress(done: 1, target: 1, completion: 1, reached: true, expected: 1, onTrack: true, needPerDay: 0))
        let slipped = try HabitRules.periodProgress(
            Self.abstain(), logs: [HabitLog(day: today, value: 1, status: .done)], today: today, weekStart: .sun
        )
        #expect(slipped == PeriodProgress(done: 0, target: 1, completion: 0, reached: false, expected: 1, onTrack: false, needPerDay: 1))
    }
}
