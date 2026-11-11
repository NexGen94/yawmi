import Domain
import Foundation
import Testing

/// The Swift types mirror `api/yawmi/domain/habits.py`: same names, same raw values.
struct HabitModelTests {
    @Test
    func enumsUseThePythonRawValues() {
        #expect(HabitKind.allCases.map(\.rawValue) == ["boolean", "count", "duration"])
        #expect(HabitUnit.allCases.map(\.rawValue) == ["session", "min", "hour"])
        #expect(HabitPeriod.allCases.map(\.rawValue) == ["day", "week", "month"])
        #expect(ScheduleKind.allCases.map(\.rawValue) == ["every_day", "weekdays", "every_n_days"])
        #expect(WeekStart.allCases.map(\.rawValue) == ["sat", "sun", "mon"])
        #expect(HabitLogStatus.allCases.map(\.rawValue) == ["done", "skip", "vacation", "missed"])
        #expect(HabitPolarity.allCases.map(\.rawValue) == ["build", "abstain"])
    }

    @Test
    func specPolarityIsBuildWhenMissingAndDecodesAbstain() throws {
        let build = #"{"kind":"boolean","unit":null,"target_per_period":1,"period":"day","schedule_kind":"every_day","start_day":"2026-11-01"}"#
        #expect(try JSONDecoder().decode(HabitSpec.self, from: Data(build.utf8)).polarity == .build)
        let abstain = #"{"kind":"boolean","unit":null,"target_per_period":1,"period":"day","schedule_kind":"every_day","start_day":"2026-11-01","polarity":"abstain"}"#
        let spec = try JSONDecoder().decode(HabitSpec.self, from: Data(abstain.utf8))
        #expect(spec.polarity == .abstain)
        #expect(try JSONDecoder().decode(HabitSpec.self, from: JSONEncoder().encode(spec)) == spec)
        let unknown = #"{"kind":"boolean","target_per_period":1,"period":"day","schedule_kind":"every_day","start_day":"2026-11-01","polarity":"quit"}"#
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(HabitSpec.self, from: Data(unknown.utf8)) }
    }

    @Test
    func specDecodesVectorStyleSnakeCaseJSON() throws {
        let json = """
        {"kind":"duration","unit":"min","target_per_period":150,"period":"week","schedule_kind":"every_day",\
        "start_day":"2026-10-31","end_day":"2031-12-31"}
        """
        let spec = try JSONDecoder().decode(HabitSpec.self, from: Data(json.utf8))
        #expect(spec == HabitSpec(
            kind: .duration,
            unit: .min,
            targetPerPeriod: 150,
            period: .week,
            scheduleKind: .everyDay,
            weekdayMask: nil,
            everyN: nil,
            anchorDay: nil,
            startDay: DayKey(year: 2026, month: 10, day: 31),
            endDay: DayKey(year: 2031, month: 12, day: 31)
        ))
    }

    @Test
    func specDecodesOptionalScheduleFields() throws {
        let json = """
        {"kind":"boolean","unit":null,"target_per_period":1,"period":"day","schedule_kind":"every_n_days",\
        "every_n":3,"anchor_day":"2026-11-01","start_day":"2026-10-31","end_day":null}
        """
        let spec = try JSONDecoder().decode(HabitSpec.self, from: Data(json.utf8))
        #expect(spec.unit == nil)
        #expect(spec.scheduleKind == .everyNDays)
        #expect(spec.everyN == 3)
        #expect(spec.anchorDay == DayKey(year: 2026, month: 11, day: 1))
        #expect(spec.endDay == nil)
    }

    @Test
    func specRoundTripsWithSnakeCaseKeys() throws {
        let spec = HabitSpec(
            kind: .count,
            unit: .session,
            targetPerPeriod: 2.5,
            period: .day,
            scheduleKind: .weekdays,
            weekdayMask: 0b0101010,
            everyN: nil,
            anchorDay: nil,
            startDay: DayKey(year: 2026, month: 10, day: 31),
            endDay: nil
        )
        let data = try JSONEncoder().encode(spec)
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"target_per_period\":2.5"))
        #expect(text.contains("\"schedule_kind\":\"weekdays\""))
        #expect(text.contains("\"weekday_mask\":42"))
        #expect(text.contains("\"start_day\":\"2026-10-31\""))
        #expect(try JSONDecoder().decode(HabitSpec.self, from: data) == spec)
    }

    @Test
    func specReadsTheAPIsEmptyUnitAsNoUnit() throws {
        // `HabitOut.unit` in openapi/openapi.json is "" for a habit without a unit
        let json = #"{"kind":"boolean","unit":"","target_per_period":1,"period":"day","schedule_kind":"every_day","start_day":"2026-10-31"}"#
        #expect(try JSONDecoder().decode(HabitSpec.self, from: Data(json.utf8)).unit == nil)
        let unknown = #"{"kind":"count","unit":"pages","target_per_period":1,"period":"day","schedule_kind":"every_day","start_day":"2026-10-31"}"#
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(HabitSpec.self, from: Data(unknown.utf8)) }
    }

    @Test
    func specRejectsUnknownEnumValues() {
        let json = #"{"kind":"minutes","target_per_period":1,"period":"day","schedule_kind":"every_day","start_day":"2026-10-31"}"#
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(HabitSpec.self, from: Data(json.utf8)) }
    }

    @Test
    func logDecodesWithAndWithoutAValue() throws {
        let logs = try JSONDecoder().decode(
            [HabitLog].self,
            from: Data(#"[{"day":"2026-11-09","value":30,"status":"done"},{"day":"2026-11-10","status":"skip"},{"day":"2026-11-11","value":null,"status":"missed"}]"#.utf8)
        )
        #expect(logs == [
            HabitLog(day: DayKey(year: 2026, month: 11, day: 9), value: 30, status: .done),
            HabitLog(day: DayKey(year: 2026, month: 11, day: 10), value: nil, status: .skip),
            HabitLog(day: DayKey(year: 2026, month: 11, day: 11), value: nil, status: .missed),
        ])
    }
}
