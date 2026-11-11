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

    // MARK: Decimal scale (the server refuses more decimals with a 422 for the whole batch)

    /// The payload as it goes on the wire, inside an envelope.
    private static func wire<Payload: EventPayload>(_ payload: Payload) throws -> String {
        let event = try EventEnvelope(id: id, payload: payload, occurredAt: instant)
        return String(decoding: try JSONEncoder().encode(event), as: UTF8.self)
    }

    @Test
    func habitValueIsRoundedToFourDecimals() throws {
        // `Quantity` in project.py: decimal_places=4
        let payload = HabitLoggedPayload(habitCode: "read", status: .done, value: 0.1 + 0.2)
        #expect(payload.value == 0.3)
        // encode once: two encodings may order the payload's keys differently
        let wire = try Self.wire(payload)
        #expect(wire.contains(#""value":0.3}"#) || wire.contains(#""value":0.3,"#))

        var hours = HabitLoggedPayload(habitCode: "walk", status: .done)
        hours.value = 20.0 / 60  // 20 minutes on an hour-unit habit
        #expect(hours.value == 0.3333)
        #expect(try hours.jsonObject()["value"] == .number(0.3333))
    }

    @Test
    func focusMinutesAreRoundedToFourDecimals() throws {
        // `Minutes` in project.py: decimal_places=4; a session of 1471 seconds
        let payload = FocusEndedPayload(actualMinutes: 1471.0 / 60)
        #expect(payload.actualMinutes == 24.5167)
        #expect(try Self.wire(payload).contains(#""actual_minutes":24.5167"#))

        var later = FocusEndedPayload()
        later.actualMinutes = 1471.0 / 60
        #expect(later.actualMinutes == 24.5167)
    }

    @Test
    func breathRateIsRoundedToThreeDecimals() throws {
        // `breaths_per_min` in project.py: decimal_places=3
        let payload = BreathEndedPayload(pattern: "box", breathsPerMin: 60.0 / 11)
        #expect(payload.breathsPerMin == 5.455)
        #expect(try Self.wire(payload).contains(#""breaths_per_min":5.455"#))

        var later = BreathEndedPayload(pattern: "box")
        later.breathsPerMin = 60.0 / 11
        #expect(later.breathsPerMin == 5.455)
    }

    @Test
    func decodedDecimalsAreRoundedTooSoAPayloadEqualsItsRoundTrip() throws {
        let logged = try HabitLoggedPayload(jsonObject: ["habit_code": .string("read"), "status": .string("done"), "value": .number(0.123456)])
        #expect(logged.value == 0.1235)
        let focus = try FocusEndedPayload(jsonObject: ["actual_minutes": .number(24.516666666666666)])
        #expect(focus.actualMinutes == 24.5167)
        let breath = try BreathEndedPayload(jsonObject: ["pattern": .string("box"), "breaths_per_min": .number(5.4545454545)])
        #expect(breath.breathsPerMin == 5.455)

        for payload in [HabitLoggedPayload(habitCode: "read", status: .done, value: 1.0 / 3)] {
            #expect(try HabitLoggedPayload(jsonObject: payload.jsonObject()) == payload)
        }
        let minutes = FocusEndedPayload(actualMinutes: 2.0 / 3)
        #expect(try FocusEndedPayload(jsonObject: minutes.jsonObject()) == minutes)
        let rate = BreathEndedPayload(pattern: "box", breathsPerMin: 2.0 / 3)
        #expect(try BreathEndedPayload(jsonObject: rate.jsonObject()) == rate)
    }

    @Test
    func wholeAndAbsentValuesAreUnchanged() {
        #expect(HabitLoggedPayload(habitCode: "read", status: .done, value: 30).value == 30)
        #expect(HabitLoggedPayload(habitCode: "read", status: .skip).value == nil)
        #expect(FocusEndedPayload().actualMinutes == nil)
        #expect(BreathEndedPayload(pattern: "box", breathsPerMin: 6).breathsPerMin == 6)
    }
}
