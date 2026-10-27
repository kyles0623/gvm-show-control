import Foundation
import CoreBluetooth

// MARK: - Models

struct DiscoveredDevice: Identifiable {
    let id: UUID
    let peripheral: CBPeripheral
    var name: String
    var rssi: Int
    var serviceUUIDs: [CBUUID]
    var manufacturerData: Data?
    var lastSeen: Date
}

struct CharacteristicInfo: Identifiable, Hashable {
    let serviceUUID: CBUUID
    let uuid: CBUUID
    let propertiesRaw: UInt
    var userDescription: String?

    var id: String { serviceUUID.uuidString + "/" + uuid.uuidString }
    var properties: CBCharacteristicProperties { CBCharacteristicProperties(rawValue: propertiesRaw) }
    var propertyNames: [String] { BLEManager.propertyNames(properties) }
    var isWritable: Bool { properties.contains(.write) || properties.contains(.writeWithoutResponse) }
    var isOTALike: Bool {
        OTAGuard.isOTALike(service: serviceUUID, characteristic: uuid, userDescription: userDescription)
    }
}

/// Heuristic block-list for firmware-update endpoints. Writes to anything
/// matched here are refused by BLEManager.send().
enum OTAGuard {
    static let knownUUIDs: Set<String> = [
        "FE59",                                   // Nordic Secure DFU service
        "00001530-1212-EFDE-1523-785FEABCD123",   // Nordic legacy DFU service
        "00001531-1212-EFDE-1523-785FEABCD123",   // Nordic legacy DFU control point
        "00001532-1212-EFDE-1523-785FEABCD123",   // Nordic legacy DFU packet
        "00001534-1212-EFDE-1523-785FEABCD123",   // Nordic legacy DFU version
        "8EC90001-F315-4F60-9FB8-838830DAEA50",   // Nordic Secure DFU control point
        "8EC90002-F315-4F60-9FB8-838830DAEA50",   // Nordic Secure DFU packet
        "8EC90003-F315-4F60-9FB8-838830DAEA50",   // Nordic buttonless DFU
        "F000FFC0-0451-4000-B000-000000000000",   // TI OAD service
        "F000FFC1-0451-4000-B000-000000000000",   // TI OAD image identify
        "F000FFC2-0451-4000-B000-000000000000",   // TI OAD image block
        "00010203-0405-0607-0809-0A0B0C0D2B12",   // Telink OTA characteristic
        "1D14D6EE-FD63-4FA1-BFA4-8F47B42119F0",   // Silicon Labs OTA service
        "F7BF3564-FB6D-4E53-88A4-5E37E0326063",   // Silicon Labs OTA control
    ]
    static let keywords = ["dfu", "ota", "oad", "update", "firmware", "upgrade", "bootloader"]

    static func isOTALike(service: CBUUID, characteristic: CBUUID, userDescription: String?) -> Bool {
        if knownUUIDs.contains(service.uuidString.uppercased()) { return true }
        if knownUUIDs.contains(characteristic.uuidString.uppercased()) { return true }
        let text = [service.description, characteristic.description, userDescription ?? ""]
            .joined(separator: " ").lowercased()
        return keywords.contains { text.contains($0) }
    }
}

// MARK: - BLEManager

final class BLEManager: NSObject, ObservableObject {
    enum ConnectionState: String { case disconnected, connecting, connected }

    struct LogLine: Identifiable {
        let id: Int
        let text: String
    }

    static let logCap = 500

    @Published private(set) var bluetoothState: CBManagerState = .unknown
    @Published private(set) var isScanning = false
    @Published private(set) var devices: [UUID: DiscoveredDevice] = [:]
    @Published private(set) var connectedPeripheral: CBPeripheral?
    @Published private(set) var connectionState: ConnectionState = .disconnected
    @Published private(set) var characteristics: [CharacteristicInfo] = []
    @Published private(set) var lastValues: [String: Data] = [:]
    @Published var selectedWriteTargetID: String?
    @Published private(set) var log: [LogLine] = []
    @Published private(set) var logFileURL: URL?

    private var central: CBCentralManager!
    private var pendingPeripheral: CBPeripheral?
    private var charRefs: [String: CBCharacteristic] = [:]
    private var logSeq = 0
    private var logFile: FileHandle?
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    override init() {
        super.init()
        openLogFile()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: Actions

    func startScan() {
        guard central.state == .poweredOn else {
            appendLog("SCAN blocked: Bluetooth state = \(Self.stateName(central.state))")
            return
        }
        devices.removeAll()
        central.scanForPeripherals(withServices: nil,
                                   options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        isScanning = true
        appendLog("SCAN started (no service filter)")
    }

    func stopScan() {
        guard isScanning else { return }
        central.stopScan()
        isScanning = false
        appendLog("SCAN stopped (\(devices.count) devices seen)")
    }

    func connect(_ id: UUID) {
        guard let device = devices[id] else { return }
        if isScanning { stopScan() }
        if let current = connectedPeripheral ?? pendingPeripheral {
            central.cancelPeripheralConnection(current)
        }
        resetConnectionState()
        pendingPeripheral = device.peripheral
        connectionState = .connecting
        let svc = device.serviceUUIDs.map { $0.uuidString }.joined(separator: ",")
        appendLog("CONNECT → \(device.name) id=\(id.uuidString) rssi=\(device.rssi) advServices=[\(svc)] mfg=\(device.manufacturerData?.hexString ?? "-")")
        central.connect(device.peripheral, options: nil)
    }

    func disconnect() {
        if let p = connectedPeripheral ?? pendingPeripheral {
            appendLog("DISCONNECT requested")
            central.cancelPeripheralConnection(p)
        }
    }

    /// Writes `data` to the selected write target. nil means the encoder is not implemented.
    func send(_ data: Data?, label: String) {
        guard let data = data else {
            appendLog("command not implemented: \(label)")
            return
        }
        guard let peripheral = connectedPeripheral else {
            appendLog("TX blocked [\(label)]: not connected")
            return
        }
        guard let targetID = selectedWriteTargetID,
              let info = characteristics.first(where: { $0.id == targetID }),
              let characteristic = charRefs[targetID] else {
            appendLog("TX blocked [\(label)]: no write characteristic selected")
            return
        }
        guard !info.isOTALike else {
            appendLog("TX blocked [\(label)]: \(info.uuid.uuidString) looks like OTA/DFU")
            return
        }
        guard info.isWritable else {
            appendLog("TX blocked [\(label)]: \(info.uuid.uuidString) is not writable")
            return
        }
        let type: CBCharacteristicWriteType =
            info.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        let maxLen = peripheral.maximumWriteValueLength(for: type)
        if data.count > maxLen {
            appendLog("WARN [\(label)]: \(data.count) bytes exceeds max \(maxLen) for \(type == .withoutResponse ? "write-without-response" : "write")")
        }
        peripheral.writeValue(data, for: characteristic, type: type)
        let mode = type == .withoutResponse ? "WWR" : "WR"
        appendLog("TX [\(label)] \(mode) \(info.uuid.uuidString) (\(data.count)B): \(data.hexString)")
    }

    func appendLog(_ message: String) {
        logSeq += 1
        let line = "\(timeFormatter.string(from: Date()))  \(message)"
        log.append(LogLine(id: logSeq, text: line))
        if log.count > Self.logCap {
            log.removeFirst(log.count - Self.logCap)
        }
        if let d = (line + "\n").data(using: .utf8) {
            logFile?.write(d)
        }
    }

    func clearLog() {
        log.removeAll()
    }

    var logText: String {
        log.map(\.text).joined(separator: "\n")
    }

    var gattDump: String {
        var lines: [String] = []
        var lastService: CBUUID?
        for c in characteristics {
            if c.serviceUUID != lastService {
                lines.append("SERVICE \(Self.uuidLabel(c.serviceUUID))")
                lastService = c.serviceUUID
            }
            var line = "  CHAR \(Self.uuidLabel(c.uuid))  [\(c.propertyNames.joined(separator: ", "))]"
            if let d = c.userDescription { line += "  desc=\"\(d)\"" }
            if c.isOTALike { line += "  [OTA/DFU-like: writes blocked]" }
            if let v = lastValues[c.id] { line += "\n      last=\(v.hexString)  ascii=\(v.asciiPreview)" }
            lines.append(line)
        }
        return lines.isEmpty ? "(no characteristics discovered yet)" : lines.joined(separator: "\n")
    }

    // MARK: Helpers

    private func resetConnectionState() {
        connectedPeripheral = nil
        pendingPeripheral = nil
        characteristics.removeAll()
        charRefs.removeAll()
        lastValues.removeAll()
        selectedWriteTargetID = nil
    }

    private func openLogFile() {
        let fm = FileManager.default
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let dir = base.appendingPathComponent("GVMLight/logs", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        let url = dir.appendingPathComponent("session-\(f.string(from: Date())).log")
        fm.createFile(atPath: url.path, contents: nil)
        logFile = try? FileHandle(forWritingTo: url)
        logFileURL = url
        appendLog("Session log file: \(url.path)")
    }

    private func charID(_ c: CBCharacteristic) -> String? {
        guard let s = c.service else { return nil }
        return s.uuid.uuidString + "/" + c.uuid.uuidString
    }

    static func uuidLabel(_ u: CBUUID) -> String {
        let desc = u.description
        return desc == u.uuidString ? u.uuidString : "\(u.uuidString) (\(desc))"
    }

    static func propertyNames(_ p: CBCharacteristicProperties) -> [String] {
        var names: [String] = []
        if p.contains(.broadcast) { names.append("broadcast") }
        if p.contains(.read) { names.append("read") }
        if p.contains(.writeWithoutResponse) { names.append("writeWithoutResponse") }
        if p.contains(.write) { names.append("write") }
        if p.contains(.notify) { names.append("notify") }
        if p.contains(.indicate) { names.append("indicate") }
        if p.contains(.authenticatedSignedWrites) { names.append("authenticatedSignedWrites") }
        if p.contains(.extendedProperties) { names.append("extendedProperties") }
        if p.contains(.notifyEncryptionRequired) { names.append("notifyEncryptionRequired") }
        if p.contains(.indicateEncryptionRequired) { names.append("indicateEncryptionRequired") }
        return names
    }

    static func stateName(_ s: CBManagerState) -> String {
        switch s {
        case .unknown: return "unknown"
        case .resetting: return "resetting"
        case .unsupported: return "unsupported"
        case .unauthorized: return "unauthorized"
        case .poweredOff: return "poweredOff"
        case .poweredOn: return "poweredOn"
        @unknown default: return "unknown(\(s.rawValue))"
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension BLEManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        bluetoothState = central.state
        appendLog("Bluetooth state: \(Self.stateName(central.state))")
        if central.state != .poweredOn {
            isScanning = false
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let rssi = RSSI.intValue
        let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advName ?? peripheral.name ?? "(unnamed)"
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
        let now = Date()

        if var existing = devices[peripheral.identifier] {
            let nameChanged = (advName != nil || peripheral.name != nil) && existing.name != name
            // Throttle UI updates to ~1/s per device unless something new arrived.
            guard nameChanged || now.timeIntervalSince(existing.lastSeen) >= 1.0 else { return }
            if rssi != 127 { existing.rssi = rssi }
            if nameChanged { existing.name = name }
            if !services.isEmpty { existing.serviceUUIDs = services }
            if mfg != nil { existing.manufacturerData = mfg }
            existing.lastSeen = now
            devices[peripheral.identifier] = existing
        } else {
            devices[peripheral.identifier] = DiscoveredDevice(
                id: peripheral.identifier, peripheral: peripheral, name: name,
                rssi: rssi == 127 ? -127 : rssi, serviceUUIDs: services,
                manufacturerData: mfg, lastSeen: now)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        pendingPeripheral = nil
        connectedPeripheral = peripheral
        connectionState = .connected
        peripheral.delegate = self
        appendLog("CONNECTED \(peripheral.name ?? peripheral.identifier.uuidString); maxWrite WR=\(peripheral.maximumWriteValueLength(for: .withResponse)) WWR=\(peripheral.maximumWriteValueLength(for: .withoutResponse))")
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        appendLog("CONNECT FAILED: \(error?.localizedDescription ?? "unknown error")")
        resetConnectionState()
        connectionState = .disconnected
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if let error = error {
            appendLog("DISCONNECTED (error: \(error.localizedDescription))")
        } else {
            appendLog("DISCONNECTED")
        }
        resetConnectionState()
        connectionState = .disconnected
    }
}

// MARK: - CBPeripheralDelegate

extension BLEManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error = error {
            appendLog("Service discovery error: \(error.localizedDescription)")
            return
        }
        for service in peripheral.services ?? [] {
            appendLog("SERVICE \(Self.uuidLabel(service.uuid))\(service.isPrimary ? "" : " (secondary)")")
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error = error {
            appendLog("Characteristic discovery error in \(service.uuid.uuidString): \(error.localizedDescription)")
            return
        }
        for c in service.characteristics ?? [] {
            let info = CharacteristicInfo(serviceUUID: service.uuid, uuid: c.uuid,
                                          propertiesRaw: c.properties.rawValue, userDescription: nil)
            characteristics.append(info)
            charRefs[info.id] = c
            appendLog("  CHAR \(Self.uuidLabel(c.uuid)) in \(service.uuid.uuidString) [\(info.propertyNames.joined(separator: ", "))]\(info.isOTALike ? " [OTA/DFU-like]" : "")")

            peripheral.discoverDescriptors(for: c)

            if (c.properties.contains(.notify) || c.properties.contains(.indicate)) && !info.isOTALike {
                peripheral.setNotifyValue(true, for: c)
            }
            if c.properties.contains(.read) {
                peripheral.readValue(for: c)
            }
            if selectedWriteTargetID == nil && info.isWritable && !info.isOTALike {
                selectedWriteTargetID = info.id
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            appendLog("RX error \(characteristic.uuid.uuidString): \(error.localizedDescription)")
            return
        }
        let value = characteristic.value ?? Data()
        if let id = charID(characteristic) { lastValues[id] = value }
        appendLog("RX \(characteristic.uuid.uuidString) (\(value.count)B): \(value.hexString)  ascii=\(value.asciiPreview)")
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            appendLog("SUBSCRIBE error \(characteristic.uuid.uuidString): \(error.localizedDescription)")
        } else {
            appendLog("SUBSCRIBE \(characteristic.uuid.uuidString) notifying=\(characteristic.isNotifying)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            appendLog("WRITE error \(characteristic.uuid.uuidString): \(error.localizedDescription)")
        } else {
            appendLog("WRITE ack \(characteristic.uuid.uuidString)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverDescriptorsFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil else { return }
        for d in characteristic.descriptors ?? []
        where d.uuid == CBUUID(string: CBUUIDCharacteristicUserDescriptionString) {
            peripheral.readValue(for: d)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor descriptor: CBDescriptor, error: Error?) {
        guard error == nil,
              descriptor.uuid == CBUUID(string: CBUUIDCharacteristicUserDescriptionString),
              let c = descriptor.characteristic,
              let id = charID(c) else { return }
        let text: String?
        if let s = descriptor.value as? String {
            text = s
        } else if let d = descriptor.value as? Data {
            text = String(data: d, encoding: .utf8)
        } else {
            text = nil
        }
        guard let desc = text, let idx = characteristics.firstIndex(where: { $0.id == id }) else { return }
        characteristics[idx].userDescription = desc
        appendLog("DESC \(c.uuid.uuidString) user description=\"\(desc)\"")
        if characteristics[idx].isOTALike && selectedWriteTargetID == id {
            selectedWriteTargetID = nil
            appendLog("Write target cleared: \(c.uuid.uuidString) description looks like OTA/DFU")
        }
    }
}

// MARK: - Hex helpers

extension Data {
    /// "AA 55 10 1F"
    var hexString: String {
        map { String(format: "%02X", $0) }.joined(separator: " ")
    }

    /// Printable ASCII with "." for other bytes.
    var asciiPreview: String {
        String(map { (0x20...0x7E).contains($0) ? Character(UnicodeScalar($0)) : "." })
    }

    /// Parses "AA 55 0x10, 1f", "aa55", "0xAA,0x55", "AA:55". Tokens are split on
    /// whitespace , ; : - . A 1-digit token is one byte ("f" = 0x0F); longer tokens
    /// must have an even number of hex digits. Returns nil on any invalid token.
    static func fromHex(_ input: String) -> Data? {
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",;:-"))
        var bytes: [UInt8] = []
        for raw in input.components(separatedBy: separators) where !raw.isEmpty {
            var token = raw
            if token.lowercased().hasPrefix("0x") { token = String(token.dropFirst(2)) }
            guard !token.isEmpty, token.allSatisfy({ $0.isHexDigit }) else { return nil }
            if token.count == 1 { token = "0" + token }
            guard token.count % 2 == 0 else { return nil }
            var i = token.startIndex
            while i < token.endIndex {
                let j = token.index(i, offsetBy: 2)
                guard let b = UInt8(token[i..<j], radix: 16) else { return nil }
                bytes.append(b)
                i = j
            }
        }
        return bytes.isEmpty ? nil : Data(bytes)
    }
}
