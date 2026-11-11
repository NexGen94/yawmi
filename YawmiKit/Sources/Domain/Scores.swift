import Foundation

/// Health scores derived from the watch: personal baseline, recovery, TRIMP, strain and data
/// quality. A port of `api/yawmi/domain/scores.py`, the reference; the shared vectors in
/// `contracts/domain-vectors/v1` (`baseline`, `recovery`, `trimp`, `strain`) prove they agree.
///
/// The method is published (spec § 3.3) and rests on a personal baseline, not on general
/// thresholds. The constants mirror the reference's, which is their single source.
public enum Scores {
    /// The baseline window: the 28 calendar days before the day, `[day − 28, day − 1]` (D-065).
    public static let windowDays = 28
    /// Fewer valid nights than this in the window: no baseline.
    public static let minNights = 7
    /// The length of a week block inside the window: four blocks of 7 days.
    public static let weekDays = 7
    /// The baseline is `full` when every week block holds at least this many valid nights (D-065).
    public static let minNightsPerWeek = 4

    public static let weightHRV = 0.5
    public static let weightRHR = 0.3
    public static let weightSleep = 0.2

    /// `(a, b)` of Banister's TRIMP.
    public static let trimpMale = (a: 0.64, b: 1.92)
    public static let trimpFemale = (a: 0.86, b: 1.67)

    public static let strainMax = 21.0
    public static let strainScale = 120.0

    /// Fewer HRV samples than this in a night: `low` data quality.
    public static let minHRVSamples = 3

    // MARK: Baseline

    /// The baseline window of `day`: `[day − 28, day − 1]`, both ends included.
    public static func baselineWindow(for day: DayKey) -> ClosedRange<DayKey> {
        DayKey(epochDay: day.epochDay - windowDays)...DayKey(epochDay: day.epochDay - 1)
    }

    /// The baseline quality given the days of the valid nights (D-065).
    ///
    /// Only nights inside the window count, a repeated day once. Fewer than 7: `nil`. `full` when
    /// each of the four blocks `[day−28...day−22]`, `[day−21...day−15]`, `[day−14...day−8]` and
    /// `[day−7...day−1]` holds at least 4 nights, else `provisional`.
    public static func baselineQuality(nights: [DayKey], day: DayKey) -> BaselineQuality? {
        let window = baselineWindow(for: day)
        let inside = Set(nights.filter(window.contains))
        guard inside.count >= minNights else { return nil }
        var perBlock = [Int](repeating: 0, count: windowDays / weekDays)
        let first = window.lowerBound.epochDay
        for night in inside {
            perBlock[(night.epochDay - first) / weekDays] += 1
        }
        return perBlock.allSatisfy { $0 >= minNightsPerWeek } ? .full : .provisional
    }

    /// The personal baseline of `day` from dated valid nights.
    ///
    /// The caller passes valid nights only (no empty values, no zeros); the nights inside
    /// `[day − 28, day − 1]` are used and the others ignored. The quality is `baselineQuality`'s.
    /// Mean and sample standard deviation (divided by n − 1) over the window's values, on `ln(x)`
    /// when `log` is set (for HRV). Throws for a non-finite value, and for a value not above zero
    /// with `log`; both only once the window holds enough nights, as in the reference.
    ///
    /// The mean is `fsum / n`, as `statistics.fmean`. The standard deviation is a two-pass sum of
    /// squared deviations with the corrected term, on `fsum`; the reference sums exact fractions,
    /// so the two differ by a few ulps at most.
    public static func baseline(
        nights: [(day: DayKey, value: Double)], day: DayKey, log: Bool = false
    ) throws(ScoreError) -> Baseline? {
        let window = baselineWindow(for: day)
        let inside = nights.filter { window.contains($0.day) }
        guard let quality = baselineQuality(nights: inside.map(\.day), day: day) else { return nil }
        var values = inside.map(\.value)
        for value in values {
            try requireFinite(value, "value")
        }
        if log {
            if values.contains(where: { $0 <= 0 }) { throw .notPositiveForLog }
            values = values.map(naturalLog)
        }
        let count = Double(values.count)
        let mean = fsum(values) / count
        let deviations = values.map { $0 - mean }
        let correction = fsum(deviations)
        let squares = fsum(deviations.map { $0 * $0 }) - correction * correction / count
        return Baseline(
            mean: mean,
            sd: (max(0, squares) / (count - 1)).squareRoot(),
            n: values.count,
            quality: quality
        )
    }

    /// The standard score `z = (x − mean) / sd`, with `x = ln(value)` when `log` is set.
    ///
    /// Throws for a non-finite value, and for a value not above zero with `log`. With `sd == 0`
    /// (no spread in the baseline) the score is 0.
    public static func zscore(_ value: Double, baseline: Baseline, log: Bool = false) throws(ScoreError) -> Double {
        try requireFinite(value, "value")
        var x = value
        if log {
            if value <= 0 { throw .notPositiveForLog }
            x = naturalLog(value)
        }
        if baseline.sd == 0 { return 0 }
        return (x - baseline.mean) / baseline.sd
    }

    // MARK: Recovery, TRIMP and strain

    /// Recovery from 0 to 100:
    /// `⌊100·Φ(0.5·zHRV + 0.3·zRHR + 0.2·zSleep) − penalty + 0.5⌋`, clipped to [0, 100].
    ///
    /// Halves round up (not to even), as in the reference and the web. The penalty (breathing or
    /// temperature deviation) is subtracted before clipping. The sign of each z is the caller's.
    /// Throws for a non-finite input.
    public static func recovery(zHRV: Double, zRHR: Double, zSleep: Double, penalty: Double = 0) throws(ScoreError) -> Int {
        try requireFinite(zHRV, "z_hrv")
        try requireFinite(zRHR, "z_rhr")
        try requireFinite(zSleep, "z_sleep")
        try requireFinite(penalty, "penalty")
        let combined = weightHRV * zHRV + weightRHR * zRHR + weightSleep * zSleep
        let score = (100.0 * phi(combined) - penalty + 0.5).rounded(.down)
        // clipped as a Double, so a huge penalty cannot trap in the Int conversion
        return Int(min(100, max(0, score)))
    }

    /// Banister's training load (TRIMP) of one exercise segment: `minutes · r · a · exp(b·r)`,
    /// r the heart rate reserve (0 to 1), `(a, b)` = (0.64, 1.92) for men and (0.86, 1.67) for
    /// women. Negative minutes count 0 and r is clipped to [0, 1]. Throws for a non-finite input.
    public static func trimp(minutes: Double, hrReserve: Double, female: Bool = false) throws(ScoreError) -> Double {
        try requireFinite(minutes, "minutes")
        try requireFinite(hrReserve, "hr_reserve")
        let (a, b) = female ? trimpFemale : trimpMale
        let clippedMinutes = max(0, minutes)
        let r = min(1, max(0, hrReserve))
        return clippedMinutes * r * a * exp(b * r)
    }

    /// Strain from 0 to 21 on a saturating curve: `21·(1 − exp(−TRIMP/120))`. A negative load
    /// counts 0. Throws for a non-finite load.
    public static func strain(trimpTotal: Double) throws(ScoreError) -> Double {
        try requireFinite(trimpTotal, "trimp_total")
        let total = max(0, trimpTotal)
        return strainMax * (1.0 - exp(-total / strainScale))
    }

    /// A night's data quality: `missing` without a watch night, `low` with fewer than 3 HRV
    /// samples, else `ok`. A missing night is not a zero and stays out of the baseline.
    public static func dataQuality(hasWatchNight: Bool, hrvSamples: Int) -> DataQuality {
        if !hasWatchNight { return .missing }
        if hrvSamples < minHRVSamples { return .low }
        return .ok
    }

    // MARK: Internals

    /// The standard normal cumulative distribution `Φ(x) = ½·(1 + erf(x/√2))`.
    static func phi(_ x: Double) -> Double {
        0.5 * (1.0 + erf(x / 2.0.squareRoot()))
    }

    static func requireFinite(_ value: Double, _ name: String) throws(ScoreError) {
        if !value.isFinite { throw .nonFinite(name) }
    }

    /// The correctly rounded sum of finite `values`, as Python's `math.fsum`: Shewchuk's exact
    /// partials, then CPython's half-even correction across partials.
    static func fsum(_ values: [Double]) -> Double {
        var partials: [Double] = []
        for value in values {
            var x = value
            var kept = 0
            for index in partials.indices {
                var y = partials[index]
                if abs(x) < abs(y) { swap(&x, &y) }
                let hi = x + y
                let lo = y - (hi - x)
                if lo != 0 {
                    partials[kept] = lo
                    kept += 1
                }
                x = hi
            }
            partials.removeSubrange(kept...)
            if x != 0 { partials.append(x) }
        }
        guard var hi = partials.last else { return 0 }
        var n = partials.count - 1
        var lo = 0.0
        while n > 0 {
            let x = hi
            n -= 1
            let y = partials[n]
            hi = x + y
            lo = y - (hi - x)
            if lo != 0 { break }
        }
        if n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0)) {
            let y = lo * 2
            let x = hi + y
            if y == x - hi { hi = x }
        }
        return hi
    }
}

/// `ln(x)`, named apart from `log` so the `log:` parameters above do not shadow it.
func naturalLog(_ x: Double) -> Double {
    log(x)
}

/// A personal baseline: mean, standard deviation, number of nights and quality. Computed with
/// `log: true` (HRV), `mean` and `sd` are on the `ln(x)` scale, not the raw values.
public struct Baseline: Hashable, Sendable {
    public let mean: Double
    public let sd: Double
    public let n: Int
    public let quality: BaselineQuality

    public init(mean: Double, sd: Double, n: Int, quality: BaselineQuality) {
        self.mean = mean
        self.sd = sd
        self.n = n
        self.quality = quality
    }
}

/// `full` when every week of the window has at least 4 valid nights, else `provisional` (D-065).
public enum BaselineQuality: String, Codable, Sendable, Hashable, CaseIterable {
    case provisional, full
}

/// A night's data quality.
public enum DataQuality: String, Codable, Sendable, Hashable, CaseIterable {
    case missing, low, ok
}

/// Inputs the score functions refuse, as the reference raises `ValueError` for them.
public enum ScoreError: Error, Hashable, Sendable, CustomStringConvertible {
    /// The named input is NaN or infinite.
    case nonFinite(String)
    /// A log-scale value (HRV) is not above zero.
    case notPositiveForLog

    public var description: String {
        switch self {
        case .nonFinite(let name): "\(name) must be finite"
        case .notPositiveForLog: "log scale requires strictly positive values"
        }
    }
}
