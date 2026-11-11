import Domain
import Foundation
import Testing

struct DayKeyTests {
    private static func date(_ unixSeconds: Double) -> Date {
        Date(timeIntervalSince1970: unixSeconds)
    }

    // MARK: Riyadh day boundary (UTC+3, no daylight saving)

    @Test
    func riyadhIsAFixedPlusThreeOffsetWithoutDaylightSaving() {
        for unix in [0.0, 1_794_257_999, 1_752_000_000, 1_770_000_000] {
            #expect(DayBoundary.riyadh.secondsFromGMT(for: Self.date(unix)) == 3 * 3600)
        }
    }

    @Test
    func justBeforeRiyadhMidnightStaysOnTheSameDay() {
        // 2026-11-09T20:59:59Z is 23:59:59 in Riyadh
        let key = DayBoundary.dayKey(for: Self.date(1_794_257_999), timeZone: DayBoundary.riyadh)
        #expect(key == DayKey(year: 2026, month: 11, day: 9))
    }

    @Test
    func riyadhMidnightStartsTheNextDay() {
        // 2026-11-09T21:00:00Z is 00:00:00 on 2026-11-10 in Riyadh
        let key = DayBoundary.dayKey(for: Self.date(1_794_258_000), timeZone: DayBoundary.riyadh)
        #expect(key == DayKey(year: 2026, month: 11, day: 10))
    }

    @Test
    func lateUTCEventBelongsToTheNextRiyadhDay() {
        // 2026-11-09T23:30:00Z is 02:30 on 2026-11-10 in Riyadh
        let key = DayBoundary.dayKey(for: Self.date(1_794_267_000), timeZone: DayBoundary.riyadh)
        #expect(key == DayKey(year: 2026, month: 11, day: 10))
    }

    @Test
    func fractionalSecondsFloorInsteadOfRounding() {
        let key = DayBoundary.dayKey(for: Self.date(1_794_257_999.999), timeZone: DayBoundary.riyadh)
        #expect(key == DayKey(year: 2026, month: 11, day: 9))
    }

    @Test
    func monthAndLeapDayBoundaries() {
        // 2026-02-28T21:00:00Z is 2026-03-01 in Riyadh; 2028-02-29T00:00:00Z is 03:00 on the leap day
        #expect(DayBoundary.dayKey(for: Self.date(1_772_312_400), timeZone: DayBoundary.riyadh) == DayKey(year: 2026, month: 3, day: 1))
        #expect(DayBoundary.dayKey(for: Self.date(1_835_395_200), timeZone: DayBoundary.riyadh) == DayKey(year: 2028, month: 2, day: 29))
    }

    @Test
    func datesBeforeTheEpochFloorCorrectly() throws {
        let utc = try #require(TimeZone(secondsFromGMT: 0))
        #expect(DayBoundary.dayKey(for: Self.date(-1), timeZone: utc) == DayKey(year: 1969, month: 12, day: 31))
        #expect(DayBoundary.dayKey(for: Self.date(-1), timeZone: DayBoundary.riyadh) == DayKey(year: 1970, month: 1, day: 1))
    }

    @Test
    func otherZonesFollowTheirOwnOffset() throws {
        // 2026-11-09T20:59:59Z is still the 9th west of UTC and 05:59:59 on the 10th at UTC+9
        let tokyo = try #require(TimeZone(secondsFromGMT: 9 * 3600))
        let newYork = try #require(TimeZone(secondsFromGMT: -5 * 3600))
        #expect(DayBoundary.dayKey(for: Self.date(1_794_257_999), timeZone: tokyo) == DayKey(year: 2026, month: 11, day: 10))
        #expect(DayBoundary.dayKey(for: Self.date(1_794_257_999), timeZone: newYork) == DayKey(year: 2026, month: 11, day: 9))
    }

    // MARK: Epoch-day conversion

    @Test(arguments: [(-1, 1969, 12, 31), (0, 1970, 1, 1), (11_017, 2000, 3, 1), (20_766, 2026, 11, 9), (21_243, 2028, 2, 29)])
    func epochDayConvertsBothWays(epochDay: Int, year: Int, month: Int, day: Int) {
        let key = DayKey(year: year, month: month, day: day)
        #expect(key.epochDay == epochDay)
        #expect(DayKey(epochDay: epochDay) == key)
    }

    @Test
    func epochDayRoundTripsAcrossManyYears() {
        for epochDay in stride(from: -800_000, through: 900_000, by: 997) {
            #expect(DayKey(epochDay: epochDay).epochDay == epochDay)
        }
    }

    // MARK: Comparison

    @Test
    func comparesByYearThenMonthThenDay() {
        let a = DayKey(year: 2026, month: 11, day: 9)
        #expect(a < DayKey(year: 2026, month: 11, day: 10))
        #expect(a < DayKey(year: 2026, month: 12, day: 1))
        #expect(a < DayKey(year: 2027, month: 1, day: 1))
        #expect(DayKey(year: 2026, month: 11, day: 10) > a)
        #expect(!(a < a))
        #expect(a <= DayKey(year: 2026, month: 11, day: 9))
        let unsorted = [DayKey(year: 2027, month: 1, day: 1), a, DayKey(year: 2026, month: 2, day: 28)]
        #expect(unsorted.sorted() == [DayKey(year: 2026, month: 2, day: 28), a, DayKey(year: 2027, month: 1, day: 1)])
    }

    @Test
    func isHashable() {
        let set: Set<DayKey> = [
            DayKey(year: 2026, month: 11, day: 9),
            DayKey(year: 2026, month: 11, day: 9),
            DayKey(year: 2026, month: 11, day: 10),
        ]
        #expect(set.count == 2)
    }

    // MARK: Codable as YYYY-MM-DD

    @Test
    func encodesAsAZeroPaddedISODateString() throws {
        let key = DayKey(year: 2026, month: 1, day: 9)
        let json = try JSONEncoder().encode(key)
        #expect(String(decoding: json, as: UTF8.self) == "\"2026-01-09\"")
        #expect(key.description == "2026-01-09")
    }

    @Test
    func decodesFromAnISODateString() throws {
        let key = try JSONDecoder().decode(DayKey.self, from: Data("\"2026-11-09\"".utf8))
        #expect(key == DayKey(year: 2026, month: 11, day: 9))
        #expect(key.year == 2026 && key.month == 11 && key.day == 9)
    }

    @Test
    func roundTripsInsideAContainer() throws {
        struct Box: Codable, Equatable {
            var day: DayKey
            var other: DayKey?
        }
        let box = Box(day: DayKey(year: 2028, month: 2, day: 29), other: nil)
        let data = try JSONEncoder().encode(box)
        #expect(try JSONDecoder().decode(Box.self, from: data) == box)
    }

    @Test(arguments: [
        "2026-13-01", "2026-00-10", "2026-02-30", "2027-02-29", "2026-11-00", "2026-11-31",
        "2026-1-9", "26-11-09", "2026/11/09", "2026-11-09T00:00:00Z", "", "bad",
    ])
    func rejectsStringsThatAreNotRealCalendarDays(text: String) throws {
        let data = try JSONEncoder().encode(text)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(DayKey.self, from: data) }
        #expect(DayKey(isoString: text) == nil)
    }

    @Test
    func acceptsLeapDaysOnlyInLeapYears() {
        #expect(DayKey(isoString: "2028-02-29") != nil)
        #expect(DayKey(isoString: "2000-02-29") != nil)
        #expect(DayKey(isoString: "1900-02-29") == nil)
        #expect(DayKey(isoString: "2026-02-29") == nil)
    }
}
