import Domain
import Foundation
import Testing

/// One case of a shared domain vector file (`contracts/domain-vectors/v1/<function>.json`).
///
/// File shape (Task 11): `{"rulesVersion": 1, "function": "<name>", "cases": [{"id", "input",
/// "expect", "tol"?, "source"}]}`. Inputs and expectations stay `JSONValue`s with the file's
/// `snake_case` keys, so each test decodes only what its function needs.
struct VectorCase: Decodable, Sendable, CustomTestStringConvertible {
    let id: String
    let input: JSONValue
    let expect: JSONValue
    /// Per-case tolerance for fractional results; `nil` means the default of 1e-9.
    let tol: Double?

    var testDescription: String { id }
}

/// Loads the vector files that Python, TypeScript and Swift all pass.
enum VectorLoader {
    /// The directory every vector file lives in, relative to the repository root.
    static let directory = "contracts/domain-vectors/v1"

    /// The rules version the files must carry (`RULES_VERSION` in `api/tools/vector_cases.py`).
    static let rulesVersion = 1

    /// The fourteen functions with a vector file, one file each (see the directory's README).
    static let functions = [
        "day_key", "period_bounds", "is_scheduled", "end_day", "period_progress", "strength", "streak",
        "challenge_progress", "adherence", "goal_prefill", "baseline", "recovery", "trimp", "strain",
    ]

    /// The cases of `<fn>.json`, or `[]` when the directory or the file does not exist yet (the
    /// vectors arrive with Task 11). A file that exists but cannot be decoded is a repository bug
    /// and stops the run, so a broken file can never pass as "no cases".
    static func load(_ fn: String, from file: String = #filePath) -> [VectorCase] {
        loadFile(fn, from: file)?.cases ?? []
    }

    /// The whole file `<fn>.json` (version, function name and cases), or `nil` when it does not
    /// exist. A malformed file stops the run, as in `load`.
    static func loadFile(_ fn: String, from file: String = #filePath) -> VectorFile? {
        guard let url = locate(fn, from: file) else { return nil }
        do {
            return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
        } catch {
            fatalError("Malformed vector file \(url.path): \(error)")
        }
    }

    /// Decodes the `cases` of one vector file.
    static func decode(_ data: Data) throws -> [VectorCase] {
        try JSONDecoder().decode(VectorFile.self, from: data).cases
    }

    /// Walks up from `file` (this source file's `#filePath`) until a directory holds
    /// `contracts/domain-vectors/v1/<fn>.json`; the walk ends at the filesystem root.
    static func locate(_ fn: String, from file: String = #filePath) -> URL? {
        repositoryFile("\(directory)/\(fn).json", from: file)
    }

    /// Walks up from `file` until a directory holds `relativePath` (slash-separated), and returns
    /// that file; `nil` when the walk reaches the filesystem root. Other contract files, such as
    /// `openapi/openapi.json`, are found the same way.
    static func repositoryFile(_ relativePath: String, from file: String = #filePath) -> URL? {
        var current = URL(fileURLWithPath: file).deletingLastPathComponent()
        while true {
            var candidate = current
            for component in relativePath.split(separator: "/") {
                candidate.appendPathComponent(String(component))
            }
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path { return nil }
            current = parent
        }
    }

    /// One vector file: `{"rulesVersion", "function", "cases"}`.
    struct VectorFile: Decodable, Sendable {
        let rulesVersion: Int
        let function: String
        let cases: [VectorCase]
    }
}
