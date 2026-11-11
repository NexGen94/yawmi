import Domain
import Foundation
import Testing

struct VectorLoaderTests {
    @Test
    func aMissingFileLoadsAsNoCases() {
        #expect(VectorLoader.load("nonexistent").isEmpty)
        #expect(VectorLoader.locate("nonexistent") == nil)
    }

    @Test
    func aMissingDirectoryLoadsAsNoCases() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yawmi-vectors-\(UUID().uuidString)", isDirectory: true)
        let nested = root.appendingPathComponent("a/b", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(VectorLoader.load("period_bounds", from: nested.appendingPathComponent("Anything.swift").path).isEmpty)
    }

    @Test
    func findsAFileInTheRepositoryRootByWalkingUp() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yawmi-vectors-\(UUID().uuidString)", isDirectory: true)
        let vectors = root.appendingPathComponent(VectorLoader.directory, isDirectory: true)
        let nested = root.appendingPathComponent("YawmiKit/Tests/DomainTests", isDirectory: true)
        try FileManager.default.createDirectory(at: vectors, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let json = """
        {"rulesVersion":1,"function":"period_bounds","cases":[
          {"id":"period_bounds-001","input":{"day":"2026-11-09","week_start":"sun"},"expect":{"start":"2026-11-08","end":"2026-11-14"},"source":"week"},
          {"id":"period_bounds-002","input":{"x":1.5},"expect":0.25,"tol":0.001,"source":"tol"}
        ]}
        """
        try Data(json.utf8).write(to: vectors.appendingPathComponent("period_bounds.json"))

        let cases = VectorLoader.load("period_bounds", from: nested.appendingPathComponent("VectorLoader.swift").path)
        #expect(cases.map(\.id) == ["period_bounds-001", "period_bounds-002"])
        #expect(cases[0].input["week_start"]?.stringValue == "sun")
        #expect(cases[0].expect["end"]?.stringValue == "2026-11-14")
        #expect(cases[0].tol == nil)
        #expect(cases[1].expect.numberValue == 0.25)
        #expect(cases[1].tol == 0.001)
    }

    @Test
    func decodesTheCasesOfAVectorFile() throws {
        let data = Data(#"{"rulesVersion":2,"function":"f","cases":[{"id":"f-001","input":{},"expect":null,"source":"s"}]}"#.utf8)
        let cases = try VectorLoader.decode(data)
        #expect(cases.count == 1)
        #expect(cases[0].id == "f-001")
        #expect(cases[0].expect.isNull)
        #expect(cases[0].testDescription == "f-001")
    }

    @Test
    func rejectsAFileWithoutCases() {
        #expect(throws: DecodingError.self) { try VectorLoader.decode(Data("{}".utf8)) }
    }
}
