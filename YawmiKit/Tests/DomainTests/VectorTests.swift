import Domain
import Foundation
import Testing

/// Every case of the fourteen shared vector files in `contracts/domain-vectors/v1`, run through
/// the Swift rules and compared by the files' rule (their README, "قواعد المقارنة"):
/// integers, strings, booleans and `null` exactly; fractions within the case's `tol`, 1e-9 when
/// it has none; objects key by key with the same key set.
///
/// The files are JSON, where `3.0` and `3` both decode to the same `Double`, so the integer or
/// fraction type of each field comes from the README's table and is fixed by the Swift result
/// types (`Int` or `Double`), as Python's `close` fixes it from the value it computes.
struct VectorTests {
    // MARK: Days and periods

    @Test(arguments: VectorLoader.load("day_key"))
    func dayKey(_ item: VectorCase) throws {
        let text = try #require(item.input["instant"]?.stringValue)
        let instant = try #require(ISO8601Instant.parse(text), "\(item.id): \(text)")
        let zoneName = try #require(item.input["tz"]?.stringValue)
        let zone = try #require(TimeZone(identifier: zoneName), "\(item.id): no zone \(zoneName)")
        check(.string(DayBoundary.dayKey(for: instant, timeZone: zone).description), item)
        if zoneName == "Asia/Riyadh" {
            // the app uses the fixed +03:00 zone, not the platform's database
            check(.string(DayBoundary.dayKey(for: instant, timeZone: DayBoundary.riyadh).description), item)
        }
    }

    @Test(arguments: VectorLoader.load("period_bounds"))
    func periodBounds(_ item: VectorCase) throws {
        let input = try decode(PeriodBoundsInput.self, item)
        let bounds = HabitRules.periodBounds(containing: input.day, period: input.period, weekStart: input.weekStart)
        check(.object(["start": .string(bounds.start.description), "end": .string(bounds.end.description)]), item)
    }

    @Test(arguments: VectorLoader.load("is_scheduled"))
    func isScheduled(_ item: VectorCase) throws {
        let input = try decode(IsScheduledInput.self, item)
        check(.bool(try HabitRules.isScheduled(input.day, for: input.habit)), item)
    }

    @Test(arguments: VectorLoader.load("end_day"))
    func endDay(_ item: VectorCase) throws {
        let input = try decode(EndDayInput.self, item)
        check(.string(try HabitRules.endDay(start: input.start, durationDays: input.durationDays).description), item)
    }

    // MARK: Habit rules

    @Test(arguments: VectorLoader.load("period_progress"))
    func periodProgress(_ item: VectorCase) throws {
        let input = try decode(HabitInput.self, item)
        let result = try HabitRules.periodProgress(input.habit, logs: input.logs, today: input.today, weekStart: input.weekStart)
        check(
            .object([
                "done": .number(result.done),
                "target": .number(result.target),
                "completion": .number(result.completion),
                "reached": .bool(result.reached),
                "expected": .number(result.expected),
                "on_track": .bool(result.onTrack),
                "need_per_day": .number(result.needPerDay),
            ]),
            item
        )
    }

    @Test(arguments: VectorLoader.load("strength"))
    func strength(_ item: VectorCase) throws {
        let input = try decode(HabitInput.self, item)
        let result = try HabitRules.strength(input.habit, logs: input.logs, today: input.today, weekStart: input.weekStart)
        check(.number(result), item)
    }

    @Test(arguments: VectorLoader.load("streak"))
    func streak(_ item: VectorCase) throws {
        let input = try decode(HabitInput.self, item)
        let result = try HabitRules.streak(input.habit, logs: input.logs, today: input.today, weekStart: input.weekStart)
        check(.int(result), item)
    }

    @Test(arguments: VectorLoader.load("challenge_progress"))
    func challengeProgress(_ item: VectorCase) throws {
        let input = try decode(HabitInput.self, item)
        let result = try HabitRules.challengeProgress(
            input.habit, logs: input.logs, today: input.today, weekStart: input.weekStart
        )
        check(
            result.map {
                .object([
                    "achieved": .int($0.achieved),
                    "total": .int($0.total),
                    "completion": .number($0.completion),
                    "remaining_days": .int($0.remainingDays),
                ])
            } ?? .null,
            item
        )
    }

    @Test(arguments: VectorLoader.load("adherence"))
    func adherence(_ item: VectorCase) throws {
        let input = try decode(HabitInput.self, item)
        let result = try HabitRules.adherence(input.habit, logs: input.logs, today: input.today, weekStart: input.weekStart)
        check(result.map(Outcome.number) ?? .null, item)
    }

    @Test(arguments: VectorLoader.load("goal_prefill"))
    func goalPrefill(_ item: VectorCase) throws {
        let input = try decode(GoalPrefillInput.self, item)
        let result = try HabitRules.goalPrefill(
            goalTarget: input.goalTarget, current: input.current, today: input.today,
            deadline: input.deadline, period: input.period, weekStart: input.weekStart
        )
        check(.int(result), item)
    }

    // MARK: Health scores

    @Test(arguments: VectorLoader.load("baseline"))
    func baseline(_ item: VectorCase) throws {
        let input = try decode(BaselineInput.self, item)
        let result = try Scores.baseline(nights: input.nights.map { ($0.day, $0.value) }, day: input.day, log: input.log)
        check(
            result.map {
                .object([
                    "mean": .number($0.mean),
                    "sd": .number($0.sd),
                    "n": .int($0.n),
                    "quality": .string($0.quality.rawValue),
                ])
            } ?? .null,
            item
        )
    }

    @Test(arguments: VectorLoader.load("recovery"))
    func recovery(_ item: VectorCase) throws {
        let input = try decode(RecoveryInput.self, item)
        let result = try Scores.recovery(zHRV: input.zHRV, zRHR: input.zRHR, zSleep: input.zSleep, penalty: input.penalty)
        check(.int(result), item)
    }

    @Test(arguments: VectorLoader.load("trimp"))
    func trimp(_ item: VectorCase) throws {
        let input = try decode(TrimpInput.self, item)
        check(.number(try Scores.trimp(minutes: input.minutes, hrReserve: input.hrReserve, female: input.female)), item)
    }

    @Test(arguments: VectorLoader.load("strain"))
    func strain(_ item: VectorCase) throws {
        let input = try decode(StrainInput.self, item)
        check(.number(try Scores.strain(trimpTotal: input.trimpTotal)), item)
    }

    // MARK: Every case is run

    /// The cases each file holds. `@Test(arguments:)` over a file that failed to load would pass
    /// with no case at all, so the counts are pinned here (332 in all, as the generator reports:
    /// the 312 of rulesVersion 1 and four abstain cases for each of five functions in version 2).
    static let caseCounts = [
        "day_key": 14, "period_bounds": 23, "is_scheduled": 28, "end_day": 10, "period_progress": 45,
        "strength": 39, "streak": 34, "challenge_progress": 24, "adherence": 26, "goal_prefill": 24,
        "baseline": 29, "recovery": 17, "trimp": 11, "strain": 8,
    ]

    @Test
    func everyFileIsRunWithAllItsCases() {
        #expect(Set(Self.caseCounts.keys) == Set(VectorLoader.functions))
        #expect(Self.caseCounts.values.reduce(0, +) == 332)
        for fn in VectorLoader.functions {
            #expect(VectorLoader.load(fn).count == Self.caseCounts[fn], "\(fn)")
        }
    }

    // MARK: Comparison

    /// A Swift result in the vectors' terms: an `Int` or a fraction is known from its type.
    indirect enum Outcome {
        case null
        case bool(Bool)
        case int(Int)
        case number(Double)
        case string(String)
        case object([String: Outcome])
    }

    private func check(_ actual: Outcome, _ item: VectorCase) {
        guard let expected = item.expect["value"] else {
            Issue.record("\(item.id): no expect.value")
            return
        }
        compare(actual, expected, tolerance: item.tol ?? 1e-9, path: item.id)
    }

    private func compare(_ actual: Outcome, _ expected: JSONValue, tolerance: Double, path: String) {
        switch actual {
        case .null:
            #expect(expected.isNull, "\(path): expected \(expected), got null")
        case .bool(let value):
            #expect(expected.boolValue == value, "\(path): expected \(expected), got \(value)")
        case .string(let value):
            #expect(expected.stringValue == value, "\(path): expected \(expected), got \(value)")
        case .int(let value):
            #expect(expected.intValue == value, "\(path): expected \(expected), got \(value)")
        case .number(let value):
            guard let wanted = expected.numberValue else {
                Issue.record("\(path): expected \(expected), got \(value)")
                return
            }
            #expect(value.isFinite && abs(value - wanted) <= tolerance, "\(path): expected \(wanted) ± \(tolerance), got \(value)")
        case .object(let fields):
            guard let wanted = expected.objectValue else {
                Issue.record("\(path): expected \(expected), got an object")
                return
            }
            #expect(Set(fields.keys) == Set(wanted.keys), "\(path): keys differ")
            for (key, value) in fields {
                if let field = wanted[key] {
                    compare(value, field, tolerance: tolerance, path: "\(path).\(key)")
                }
            }
        }
    }

    // MARK: Inputs

    private func decode<T: Decodable>(_: T.Type, _ item: VectorCase) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(item.input))
    }

    private struct PeriodBoundsInput: Decodable {
        let day: DayKey
        let period: HabitPeriod
        let weekStart: WeekStart

        enum CodingKeys: String, CodingKey {
            case day, period
            case weekStart = "week_start"
        }
    }

    private struct IsScheduledInput: Decodable {
        let day: DayKey
        let habit: HabitSpec
    }

    private struct EndDayInput: Decodable {
        let start: DayKey
        let durationDays: Int

        enum CodingKeys: String, CodingKey {
            case start
            case durationDays = "duration_days"
        }
    }

    private struct HabitInput: Decodable {
        let habit: HabitSpec
        let logs: [HabitLog]
        let today: DayKey
        let weekStart: WeekStart

        enum CodingKeys: String, CodingKey {
            case habit, logs, today
            case weekStart = "week_start"
        }
    }

    private struct GoalPrefillInput: Decodable {
        let goalTarget: Double
        let current: Double
        let today: DayKey
        let deadline: DayKey
        let period: HabitPeriod
        let weekStart: WeekStart

        enum CodingKeys: String, CodingKey {
            case current, today, deadline, period
            case goalTarget = "goal_target"
            case weekStart = "week_start"
        }
    }

    private struct BaselineInput: Decodable {
        struct Night: Decodable {
            let day: DayKey
            let value: Double
        }

        let nights: [Night]
        let day: DayKey
        let log: Bool
    }

    private struct RecoveryInput: Decodable {
        let zHRV: Double
        let zRHR: Double
        let zSleep: Double
        let penalty: Double

        enum CodingKeys: String, CodingKey {
            case penalty
            case zHRV = "z_hrv"
            case zRHR = "z_rhr"
            case zSleep = "z_sleep"
        }
    }

    private struct TrimpInput: Decodable {
        let minutes: Double
        let hrReserve: Double
        let female: Bool

        enum CodingKeys: String, CodingKey {
            case minutes, female
            case hrReserve = "hr_reserve"
        }
    }

    private struct StrainInput: Decodable {
        let trimpTotal: Double

        enum CodingKeys: String, CodingKey {
            case trimpTotal = "trimp_total"
        }
    }
}
