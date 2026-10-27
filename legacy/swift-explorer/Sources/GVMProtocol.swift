import Foundation

/// Encoders for light commands. Each returns the exact bytes to write to the
/// control characteristic, or nil if the command is not implemented.
protocol LightProtocol {
    func power(on: Bool) -> Data?
    func brightness(percent: Int) -> Data?
    func colorTemperature(kelvin: Int) -> Data?
    func hsi(hue: Int, saturation: Int, intensity: Int) -> Data?
}

/// GVM 800-RGB protocol.
///
/// STATUS: stub. No bytes are defined here yet. Every byte added in Phase 2
/// must come from a packet capture of the official app or be confirmed on
/// the real light. Do not add guessed opcodes.
struct GVMProtocol: LightProtocol {
    func power(on: Bool) -> Data? { nil }
    func brightness(percent: Int) -> Data? { nil }
    func colorTemperature(kelvin: Int) -> Data? { nil }
    func hsi(hue: Int, saturation: Int, intensity: Int) -> Data? { nil }
}
