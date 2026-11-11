import Domain
import Foundation
import Testing

struct EventEnvelopeTests {
    private static let id = UUID(uuidString: "017F22E2-79B0-7CC3-98C4-DC0C0C07398F")!

    /// 2026-11-09T20:59:59.123Z
    private static let instant = Date(timeIntervalSince1970: 1_794_257_999_123 / 1000)

    private static func envelope() -> EventEnvelope {
        EventEnvelope(
            id: id,
            type: .habitLogged,
            payload: [
                "habit_code": .string("pray"),
                "day": .string("2026-11-09"),
                "value": .number(1.5),
            ],
            occurredAt: instant,
            tz: "Asia/Riyadh"
        )
    }

    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    // MARK: Wire shape

    @Test
    func encodesSnakeCaseKeysAndAFractionalSecondISODate() throws {
        // `.sortedKeys` orders keys by their UTF-8 bytes, so "type" comes before "tz" ('y' < 'z')
        let json = String(decoding: try Self.sortedEncoder().encode(Self.envelope()), as: UTF8.self)
        #expect(json == """
        {"id":"017f22e2-79b0-7cc3-98c4-dc0c0c07398f","occurred_at":"2026-11-09T20:59:59.123Z",\
        "payload":{"day":"2026-11-09","habit_code":"pray","value":1.5},"type":"habit_logged","tz":"Asia/Riyadh"}
        """)
    }

    @Test
    func writesExactlyTheFiveWireKeysWhateverTheKeyOrder() throws {
        // independent of key order: compare the decoded structure, not the text
        let data = try JSONEncoder().encode(Self.envelope())
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded == .object([
            "id": .string("017f22e2-79b0-7cc3-98c4-dc0c0c07398f"),
            "type": .string("habit_logged"),
            "payload": .object(["day": .string("2026-11-09"), "habit_code": .string("pray"), "value": .number(1.5)]),
            "occurred_at": .string("2026-11-09T20:59:59.123Z"),
            "tz": .string("Asia/Riyadh"),
        ]))
    }

    @Test
    func roundTripsThroughJSON() throws {
        let original = Self.envelope()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: data)
        #expect(decoded == original)
        #expect(decoded.occurredAt == Self.instant)
    }

    @Test
    func millisecondsAreAlwaysWrittenEvenWhenZero() throws {
        let whole = EventEnvelope(id: Self.id, type: .appOpened, payload: [:], occurredAt: Date(timeIntervalSince1970: 1_794_258_000), tz: "Asia/Riyadh")
        let json = String(decoding: try JSONEncoder().encode(whole), as: UTF8.self)
        #expect(json.contains("\"occurred_at\":\"2026-11-09T21:00:00.000Z\""))
    }

    @Test
    func encodesDatesBeforeTheEpochAndAtYearEdges() throws {
        let before = EventEnvelope(id: Self.id, type: .appOpened, payload: [:], occurredAt: Date(timeIntervalSince1970: -0.001), tz: "UTC")
        let json = String(decoding: try JSONEncoder().encode(before), as: UTF8.self)
        #expect(json.contains("\"occurred_at\":\"1969-12-31T23:59:59.999Z\""))
        #expect(try JSONDecoder().decode(EventEnvelope.self, from: Data(json.utf8)) == before)
    }

    // MARK: Decoding what servers and web clients send

    private static func json(occurredAt: String, id: String = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f") -> Data {
        Data("""
        {"id":"\(id)","type":"habit_logged","payload":{},"occurred_at":"\(occurredAt)","tz":"Asia/Riyadh"}
        """.utf8)
    }

    @Test(arguments: [
        "2026-11-09T20:59:59.123Z",           // Swift and JavaScript toISOString
        "2026-11-09T20:59:59.123000Z",        // Python/pydantic microseconds
        "2026-11-09T20:59:59.123456+00:00",   // Python isoformat
        "2026-11-09T23:59:59.123+03:00",      // the same instant in Riyadh
        "2026-11-09T23:59:59.123+0300",       // basic offset form
        "2026-11-09T20:59:59.1235Z",          // sub-millisecond digits are truncated
    ])
    func decodesEquivalentRepresentationsOfTheSameInstant(text: String) throws {
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: Self.json(occurredAt: text))
        #expect(decoded.occurredAt == Self.instant)
    }

    @Test
    func decodesAnInstantWithoutFractionalSeconds() throws {
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: Self.json(occurredAt: "2026-11-09T21:00:00Z"))
        #expect(decoded.occurredAt == Date(timeIntervalSince1970: 1_794_258_000))
    }

    @Test
    func decodesUppercaseUUIDs() throws {
        let decoded = try JSONDecoder().decode(
            EventEnvelope.self,
            from: Self.json(occurredAt: "2026-11-09T21:00:00Z", id: "017F22E2-79B0-7CC3-98C4-DC0C0C07398F")
        )
        #expect(decoded.id == Self.id)
    }

    @Test(arguments: [
        "2026-11-09", "2026-11-09T20:59:59", "2026-13-09T20:59:59Z", "2026-02-30T20:59:59Z",
        "2026-11-09T24:00:00Z", "2026-11-09T20:60:00Z", "2026-11-09T20:59:60Z", "2026-11-09T20:59:59+24:00",
        "2026-11-09T20:59:59.Z", "yesterday", "",
    ])
    func rejectsMalformedOrNaiveDates(text: String) {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(EventEnvelope.self, from: Self.json(occurredAt: text))
        }
    }

    @Test
    func rejectsAnInvalidUUID() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(EventEnvelope.self, from: Self.json(occurredAt: "2026-11-09T21:00:00Z", id: "not-a-uuid"))
        }
    }

    @Test(arguments: ["id", "type", "payload", "occurred_at"])
    func rejectsAMissingRequiredKey(key: String) throws {
        // the keys `EventIn` requires in openapi/openapi.json
        var object = try #require(try JSONDecoder().decode(JSONValue.self, from: Self.json(occurredAt: "2026-11-09T21:00:00Z")).objectValue)
        object[key] = nil
        let data = try JSONEncoder().encode(JSONValue.object(object))
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(EventEnvelope.self, from: data) }
    }

    @Test
    func aMissingZoneIsRiyadhAsOnTheServer() throws {
        let data = Data(#"{"id":"017f22e2-79b0-7cc3-98c4-dc0c0c07398f","type":"app_opened","payload":{},"occurred_at":"2026-11-09T21:00:00Z"}"#.utf8)
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: data)
        #expect(decoded.tz == "Asia/Riyadh")
        #expect(EventEnvelope.defaultTimeZone == "Asia/Riyadh")
    }

    @Test(arguments: ["null", "[]", "1", #""x""#, "true"])
    func rejectsAPayloadThatIsNotAnObject(payload: String) {
        let data = Data("""
        {"id":"017f22e2-79b0-7cc3-98c4-dc0c0c07398f","type":"app_opened","payload":\(payload),"occurred_at":"2026-11-09T21:00:00Z","tz":"UTC"}
        """.utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(EventEnvelope.self, from: data) }
    }

    @Test
    func decodesAPulledEventOfATypeThisClientDoesNotKnow() throws {
        let data = Data(#"{"id":"017f22e2-79b0-7cc3-98c4-dc0c0c07398f","type":"sleep_logged","payload":{"h":7},"occurred_at":"2026-11-09T21:00:00Z","tz":"UTC"}"#.utf8)
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: data)
        #expect(decoded.type.rawValue == "sleep_logged")
        #expect(!decoded.type.isKnown)
        #expect(decoded.payload == ["h": .number(7)])
    }

    @Test
    func ignoresServerOnlyFieldsOnPulledEvents() throws {
        let stored = Data("""
        {"id":"017f22e2-79b0-7cc3-98c4-dc0c0c07398f","device_id":null,"type":"habit_logged","payload":{"a":1},\
        "occurred_at":"2026-11-09T20:59:59.123Z","tz":"Asia/Riyadh","received_at":"2026-11-09T21:00:01.000Z"}
        """.utf8)
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: stored)
        #expect(decoded.payload == ["a": .number(1)])
        #expect(decoded.type == .habitLogged)
        #expect(decoded.occurredAt == Self.instant)
    }
}

struct JSONValueTests {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func text(_ value: JSONValue) throws -> String {
        // wrap in an array: older Foundation encoders reject bare scalars at the top level
        let data = try sortedEncoder().encode([value])
        let text = String(decoding: data, as: UTF8.self)
        return String(text.dropFirst().dropLast())
    }

    @Test
    func roundTripsNestedStructures() throws {
        let value: JSONValue = .object([
            "null": .null,
            "flag": .bool(true),
            "off": .bool(false),
            "count": .number(3),
            "ratio": .number(0.25),
            "negative": .number(-12),
            "name": .string("رقيب \"v2\" \n tab\t unicode \u{1F600}"),
            "list": .array([.number(1), .string("two"), .bool(false), .null, .array([]), .object([:])]),
            "deep": .object(["a": .object(["b": .array([.object(["c": .number(1e-7)])])])]),
        ])
        let data = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(JSONValue.self, from: data) == value)
    }

    @Test
    func writesIntegersWithoutADecimalPointAndDecimalsWithOne() throws {
        let json = String(decoding: try Self.sortedEncoder().encode(JSONValue.object([
            "zero": .number(0),
            "count": .number(3),
            "negative": .number(-12),
            "big": .number(1_794_257_999_123),
            "ratio": .number(0.5),
            "third": .number(1.0 / 3.0),
            "tiny": .number(0.0001),
        ])), as: UTF8.self)
        #expect(json.contains("\"zero\":0,") || json.contains("\"zero\":0}"))
        #expect(json.contains("\"count\":3,"))
        #expect(json.contains("\"negative\":-12,"))
        #expect(json.contains("\"big\":1794257999123,"))
        #expect(json.contains("\"ratio\":0.5,"))
        #expect(json.contains("\"third\":0.3333333333333333,"))
        #expect(json.contains("\"tiny\":0.0001}") || json.contains("\"tiny\":0.0001,"))
        #expect(!json.contains("3.0"))
    }

    @Test
    func decodesIntegersAndDecimalsToTheSameNumberCase() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"a":3,"b":3.0,"c":0.5,"d":-7,"e":1e3}"#.utf8))
        #expect(value == .object(["a": .number(3), "b": .number(3), "c": .number(0.5), "d": .number(-7), "e": .number(1000)]))
    }

    @Test
    func booleansAndNumbersStayDistinct() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"[1,true,0,false,"true",null]"#.utf8))
        #expect(value == .array([.number(1), .bool(true), .number(0), .bool(false), .string("true"), .null]))
        #expect(try Self.text(.array([.number(1), .bool(true)])) == "[1,true]")
    }

    @Test
    func keepsIntegersExactUpToTheDoublePrecisionLimit() throws {
        let limit = 9_007_199_254_740_991.0  // 2^53 - 1
        let text = try Self.text(.number(limit))
        #expect(text == "9007199254740991")
        #expect(try JSONDecoder().decode([JSONValue].self, from: Data("[\(text)]".utf8)) == [.number(limit)])
    }

    @Test
    func throwsOnNonFiniteNumbersInsteadOfWritingInvalidJSON() {
        #expect(throws: (any Error).self) { try JSONEncoder().encode([JSONValue.number(.nan)]) }
        #expect(throws: (any Error).self) { try JSONEncoder().encode([JSONValue.number(.infinity)]) }
    }

    @Test
    func accessorsReadTypedValues() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"s":"x","n":2,"f":2.5,"b":true,"a":[1],"o":{"k":1},"z":null}"#.utf8))
        #expect(value["s"]?.stringValue == "x")
        #expect(value["n"]?.numberValue == 2)
        #expect(value["n"]?.intValue == 2)
        #expect(value["f"]?.numberValue == 2.5)
        #expect(value["f"]?.intValue == nil)
        #expect(value["b"]?.boolValue == true)
        #expect(value["a"]?.arrayValue == [.number(1)])
        #expect(value["o"]?.objectValue == ["k": .number(1)])
        #expect(value["z"]?.isNull == true)
        #expect(value["missing"] == nil)
        #expect(value["s"]?.numberValue == nil)
        #expect(JSONValue.string("x")["s"] == nil)
    }
}
