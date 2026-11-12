import Domain
import Foundation
import Testing

/// The shared vectors in `contracts/domain-vectors/v1` load, and every input the Domain types
/// model decodes into them. This checks the files' shape only; the rule results are checked by
/// `VectorTests` (Task 21b).
struct VectorContractTests {
    @Test
    func theFourteenFilesLoadWithTheirVersionAndFunction() throws {
        var total = 0
        var ids = Set<String>()
        for fn in VectorLoader.functions {
            let file = try #require(VectorLoader.loadFile(fn), "missing \(VectorLoader.directory)/\(fn).json")
            #expect(file.rulesVersion == VectorLoader.rulesVersion, "\(fn)")
            #expect(file.function == fn)
            #expect(!file.cases.isEmpty, "\(fn) has no cases")
            for item in file.cases {
                #expect(item.id.hasPrefix("\(fn)-"), "\(item.id)")
                #expect(ids.insert(item.id).inserted, "duplicate id \(item.id)")
                #expect(item.expect["value"] != nil, "\(item.id) has no expect.value")
                if let tol = item.tol { #expect(tol > 0, "\(item.id)") }
            }
            total += file.cases.count
        }
        #expect(total == 332)  // 312 cases of rulesVersion 1 and the twenty abstain cases of 2
    }

    @Test
    func noVectorFileIsLeftUnlisted() throws {
        let anyFile = try #require(VectorLoader.locate("day_key"))
        let names = try FileManager.default.contentsOfDirectory(atPath: anyFile.deletingLastPathComponent().path)
            .filter { $0.hasSuffix(".json") }
            .map { String($0.dropLast(5)) }
        #expect(Set(names) == Set(VectorLoader.functions))
    }

    @Test
    func habitsLogsAndEnumsDecodeIntoTheDomainTypes() throws {
        var habits = 0
        var logs = 0
        for fn in VectorLoader.functions {
            for item in VectorLoader.load(fn) {
                let input = item.input
                if let habit = input["habit"] {
                    let spec = try decode(HabitSpec.self, habit, item.id)
                    habits += 1
                    switch spec.scheduleKind {
                    case .everyDay:
                        break
                    case .weekdays:
                        #expect((1...127).contains(spec.weekdayMask ?? 0), "\(item.id)")
                    case .everyNDays:
                        #expect((spec.everyN ?? 0) >= 2 && spec.anchorDay != nil, "\(item.id)")
                    }
                }
                if let entries = input["logs"] {
                    logs += try decode([HabitLog].self, entries, item.id).count
                }
                if let weekStart = input["week_start"] {
                    _ = try decode(WeekStart.self, weekStart, item.id)
                }
                if let period = input["period"] {
                    _ = try decode(HabitPeriod.self, period, item.id)
                }
                for key in ["day", "today", "start", "deadline"] {
                    if let text = input[key]?.stringValue {
                        #expect(DayKey(isoString: text) != nil, "\(item.id) \(key)")
                    }
                }
            }
        }
        #expect(habits > 0)
        #expect(logs > 0)
    }

    @Test
    func dayKeyInstantsParseAndTheirZonesExist() throws {
        let cases = VectorLoader.load("day_key")
        #expect(!cases.isEmpty)
        for item in cases {
            let instant = try #require(item.input["instant"]?.stringValue, "\(item.id)")
            #expect(ISO8601Instant.parse(instant) != nil, "\(item.id) \(instant)")
            let zone = try #require(item.input["tz"]?.stringValue, "\(item.id)")
            #expect(TimeZone(identifier: zone) != nil, "\(item.id) \(zone)")
            #expect(DayKey(isoString: item.expect["value"]?.stringValue ?? "") != nil, "\(item.id)")
        }
    }

    private func decode<T: Decodable>(_: T.Type, _ value: JSONValue, _ id: String) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
        } catch {
            Issue.record("\(id): \(T.self) does not decode: \(error)")
            throw error
        }
    }
}
