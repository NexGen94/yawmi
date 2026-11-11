import Domain
import Foundation
import Testing

/// The event types and payloads match `openapi/openapi.json` and `api/yawmi/events/project.py`.
struct EventPayloadTests {
    private static let id = UUID(uuidString: "017f22e2-79b0-7cc3-98c4-dc0c0c07398f")!
    private static let instant = Date(timeIntervalSince1970: 1_794_257_999_123 / 1000)  // 2026-11-09T20:59:59.123Z

    // MARK: Event types

    @Test
    func knownTypesAreExactlyTheOpenAPIEnumInItsOrder() throws {
        let url = try #require(VectorLoader.repositoryFile("openapi/openapi.json"), "openapi/openapi.json not found above \(#filePath)")
        let spec = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        let values = try #require(spec["components"]?["schemas"]?["EventIn"]?["properties"]?["type"]?["enum"]?.arrayValue)
        #expect(EventType.allKnown.map(\.rawValue) == values.compactMap(\.stringValue))
        let allKnown = EventType.allKnown.allSatisfy { $0.isKnown }
        #expect(allKnown)
    }

    @Test
    func theEnvelopeKeysAreTheOpenAPIEventInProperties() throws {
        let url = try #require(VectorLoader.repositoryFile("openapi/openapi.json"))
        let spec = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        let eventIn = try #require(spec["components"]?["schemas"]?["EventIn"])
        let properties = try #require(eventIn["properties"]?.objectValue)
        #expect(Set(properties.keys) == ["id", "type", "payload", "occurred_at", "tz"])
        #expect(eventIn["required"]?.arrayValue?.compactMap(\.stringValue).sorted() == ["id", "occurred_at", "payload", "type"])
        #expect(properties["tz"]?["default"]?.stringValue == EventEnvelope.defaultTimeZone)
        #expect(properties["payload"]?["type"]?.stringValue == "object")
    }

    @Test
    func typesEncodeAsTheirRawStrings() throws {
        let data = try JSONEncoder().encode([EventType.habitLogged, EventType(rawValue: "future_type")])
        #expect(String(decoding: data, as: UTF8.self) == #"["habit_logged","future_type"]"#)
        #expect(try JSONDecoder().decode([EventType].self, from: data) == [.habitLogged, EventType(rawValue: "future_type")])
    }

    // MARK: Typed payloads

    @Test
    func habitLoggedWritesSnakeCaseAndLeavesOutNilFields() throws {
        let full = try HabitLoggedPayload(habitCode: "read", status: .done, day: DayKey(year: 2026, month: 11, day: 8), value: 20).jsonObject()
        #expect(full == [
            "habit_code": .string("read"),
            "status": .string("done"),
            "day": .string("2026-11-08"),
            "value": .number(20),
        ])
        let bare = try HabitLoggedPayload(habitCode: "read", status: .skip).jsonObject()
        #expect(bare == ["habit_code": .string("read"), "status": .string("skip")])
    }

    @Test
    func aClientCannotSendMissed() {
        #expect(HabitLoggedPayload.Status.allCases.map(\.rawValue) == ["done", "skip", "vacation"])
        #expect(throws: DecodingError.self) {
            try HabitLoggedPayload(jsonObject: ["habit_code": .string("read"), "status": .string("missed")])
        }
    }

    @Test
    func theEnvelopeTakesItsTypeFromThePayload() throws {
        let logged = try EventEnvelope(id: Self.id, payload: HabitLoggedPayload(habitCode: "read", status: .vacation), occurredAt: Self.instant)
        #expect(logged.type == .habitLogged)
        #expect(logged.tz == "Asia/Riyadh")
        #expect(try EventEnvelope(id: Self.id, payload: HabitSkippedPayload(habitCode: "read"), occurredAt: Self.instant).type == .habitSkipped)
        #expect(try EventEnvelope(id: Self.id, payload: HabitVacationPayload(habitCode: "read"), occurredAt: Self.instant).type == .habitVacation)
        #expect(try EventEnvelope(id: Self.id, payload: FocusEndedPayload(), occurredAt: Self.instant).type == .focusEnded)
        #expect(try EventEnvelope(id: Self.id, payload: BreathEndedPayload(pattern: "4-7-8"), occurredAt: Self.instant).type == .breathEnded)
    }

    @Test
    func aNewEnvelopeGetsAVersion7ID() throws {
        let event = try EventEnvelope(payload: HabitSkippedPayload(habitCode: "read"), occurredAt: Self.instant)
        #expect(event.id.uuidString.lowercased().dropFirst(14).first == "7")
    }

    @Test
    func payloadsRoundTripThroughTheWire() throws {
        let focus = FocusEndedPayload(
            habitCode: "deep_work",
            goalRef: "O4",
            startedAt: Date(timeIntervalSince1970: 1_794_256_499.5),
            endedAt: Self.instant,
            plannedMinutes: 25,
            actualMinutes: 24.5,
            focusRating: 4,
            nextStep: "مراجعة المسودة"
        )
        let event = try EventEnvelope(id: Self.id, payload: focus, occurredAt: Self.instant)
        let pulled = try JSONDecoder().decode(EventEnvelope.self, from: JSONEncoder().encode(event))
        #expect(try pulled.decodePayload(as: FocusEndedPayload.self) == focus)
        #expect(pulled.payload["started_at"] == .string("2026-11-09T20:34:59.500Z"))
        #expect(pulled.payload["ended_at"] == .string("2026-11-09T20:59:59.123Z"))
        #expect(pulled.payload["planned_minutes"] == .number(25))
        #expect(pulled.payload["actual_minutes"] == .number(24.5))

        let breath = BreathEndedPayload(pattern: "box", breathsPerMin: 6, durationSeconds: 300, completed: false)
        let breathEvent = try EventEnvelope(id: Self.id, payload: breath, occurredAt: Self.instant)
        #expect(Set(breathEvent.payload.keys) == ["pattern", "breaths_per_min", "duration_seconds", "completed"])
        #expect(try breathEvent.decodePayload(as: BreathEndedPayload.self) == breath)
    }

    @Test
    func breathCompletedDefaultsToTrueAsTheColumnDoes() throws {
        let payload = try BreathEndedPayload(jsonObject: ["pattern": .string("4-7-8")])
        #expect(payload.completed)
        #expect(throws: DecodingError.self) { try BreathEndedPayload(jsonObject: [:]) }
    }

    @Test
    func readingIgnoresUnknownFieldsAndAcceptsOffsetInstants() throws {
        let payload = try FocusEndedPayload(jsonObject: [
            "started_at": .string("2026-11-09T23:34:59.500+03:00"),
            "a_field_from_a_newer_client": .bool(true),
        ])
        #expect(payload.startedAt == Date(timeIntervalSince1970: 1_794_256_499.5))
        #expect(throws: DecodingError.self) { try FocusEndedPayload(jsonObject: ["started_at": .string("2026-11-09T20:34:59")]) }
    }

    @Test
    func readingAPayloadAsTheWrongTypeThrows() throws {
        let event = try EventEnvelope(id: Self.id, payload: HabitSkippedPayload(habitCode: "read"), occurredAt: Self.instant)
        #expect(throws: DecodingError.self) { try event.decodePayload(as: HabitVacationPayload.self) }
        #expect(try event.decodePayload(as: HabitSkippedPayload.self) == HabitSkippedPayload(habitCode: "read"))
    }
}
