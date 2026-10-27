import SwiftUI
import AppKit
import CoreBluetooth

struct ContentView: View {
    @EnvironmentObject var ble: BLEManager
    @State private var nameFilter = ""
    @State private var selectedDeviceID: UUID?

    var body: some View {
        NavigationSplitView {
            SidebarView(nameFilter: $nameFilter, selection: $selectedDeviceID)
                .navigationSplitViewColumnWidth(min: 260, ideal: 320)
        } detail: {
            DetailView()
        }
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @EnvironmentObject var ble: BLEManager
    @Binding var nameFilter: String
    @Binding var selection: UUID?

    private var filtered: [DiscoveredDevice] {
        let all = ble.devices.values.sorted {
            $0.rssi != $1.rssi ? $0.rssi > $1.rssi : $0.id.uuidString < $1.id.uuidString
        }
        let f = nameFilter.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { return all }
        return all.filter { $0.name.localizedCaseInsensitiveContains(f) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(ble.isScanning ? "Stop" : "Scan") {
                    if ble.isScanning { ble.stopScan() } else { ble.startScan() }
                }
                .disabled(ble.bluetoothState != .poweredOn && !ble.isScanning)
                Spacer()
                Text("BT: \(BLEManager.stateName(ble.bluetoothState))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField("Filter by name", text: $nameFilter)
                .textFieldStyle(.roundedBorder)
            List(filtered, selection: $selection) { device in
                DeviceRow(device: device,
                          isConnected: ble.connectedPeripheral?.identifier == device.id)
            }
            .contextMenu(forSelectionType: UUID.self) { ids in
                if let id = ids.first {
                    Button("Connect") { ble.connect(id) }
                }
            } primaryAction: { ids in
                if let id = ids.first { ble.connect(id) }
            }
            Text("\(filtered.count) devices · double-click to connect")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(8)
    }
}

struct DeviceRow: View {
    let device: DiscoveredDevice
    let isConnected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(device.name).fontWeight(isConnected ? .bold : .regular)
                Spacer()
                Text("\(device.rssi) dBm").monospacedDigit().foregroundStyle(.secondary)
            }
            Text(device.id.uuidString)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
            if !device.serviceUUIDs.isEmpty {
                Text("svc: " + device.serviceUUIDs.map { $0.uuidString }.joined(separator: ", "))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            if let mfg = device.manufacturerData {
                Text("mfg: " + mfg.hexString)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Detail

struct DetailView: View {
    @EnvironmentObject var ble: BLEManager

    var body: some View {
        switch ble.connectionState {
        case .connected:
            ConnectedView()
        case .connecting:
            VSplitView {
                VStack(spacing: 12) {
                    ProgressView("Connecting…")
                    Button("Cancel") { ble.disconnect() }
                }
                .frame(maxWidth: .infinity, minHeight: 160)
                LogView().frame(minHeight: 150)
            }
        case .disconnected:
            VSplitView {
                VStack(spacing: 6) {
                    Text("Not connected").font(.title3)
                    Text("Scan, then double-click a device in the sidebar.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 160)
                LogView().frame(minHeight: 150)
            }
        }
    }
}

struct ConnectedView: View {
    @EnvironmentObject var ble: BLEManager
    @State private var hexInput = ""

    private var writable: [CharacteristicInfo] {
        ble.characteristics.filter { $0.isWritable && !$0.isOTALike }
    }

    var body: some View {
        VSplitView {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(ble.connectedPeripheral?.name ?? "Connected").font(.title3).bold()
                        Text(ble.connectedPeripheral?.identifier.uuidString ?? "")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Spacer()
                        Button("Disconnect") { ble.disconnect() }
                    }

                    Picker("Write target", selection: $ble.selectedWriteTargetID) {
                        Text("— none —").tag(String?.none)
                        ForEach(writable) { c in
                            Text("\(c.uuid.uuidString)  [\(c.propertyNames.joined(separator: ", "))]  svc \(c.serviceUUID.uuidString)")
                                .tag(Optional(c.id))
                        }
                    }

                    HStack {
                        TextField("Hex bytes, e.g. AA 55 0x10, 1f", text: $hexInput)
                            .font(.system(.body, design: .monospaced))
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(sendHex)
                        Button("Send", action: sendHex)
                    }

                    ControlPanel()
                }
                .padding(12)
            }
            .frame(minHeight: 280)

            GATTView().frame(minHeight: 120)
            LogView().frame(minHeight: 150)
        }
    }

    private func sendHex() {
        guard let data = Data.fromHex(hexInput) else {
            ble.appendLog("Invalid hex input: \"\(hexInput)\"")
            return
        }
        ble.send(data, label: "raw")
    }
}

// MARK: - Control panel

struct ControlPanel: View {
    @EnvironmentObject var ble: BLEManager
    private let proto: LightProtocol = GVMProtocol()

    @State private var brightness: Double = 50
    @State private var kelvin: Double = 5600
    @State private var hue: Double = 0
    @State private var saturation: Double = 100

    var body: some View {
        GroupBox("Control panel (GVMProtocol — sends on slider release)") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button("On") { ble.send(proto.power(on: true), label: "power on") }
                    Button("Off") { ble.send(proto.power(on: false), label: "power off") }
                }
                sliderRow("Brightness", value: $brightness, range: 0...100, step: 1, unit: "%") {
                    let p = Int(brightness)
                    ble.send(proto.brightness(percent: p), label: "brightness \(p)%")
                }
                sliderRow("CCT", value: $kelvin, range: 2500...8500, step: 100, unit: "K") {
                    let k = Int(kelvin)
                    ble.send(proto.colorTemperature(kelvin: k), label: "cct \(k)K")
                }
                sliderRow("Hue", value: $hue, range: 0...360, step: 1, unit: "°") {
                    sendHSI()
                }
                sliderRow("Saturation", value: $saturation, range: 0...100, step: 1, unit: "%") {
                    sendHSI()
                }
            }
            .padding(6)
        }
    }

    private func sendHSI() {
        let h = Int(hue), s = Int(saturation), i = Int(brightness)
        ble.send(proto.hsi(hue: h, saturation: s, intensity: i), label: "hsi h=\(h) s=\(s) i=\(i)")
    }

    private func sliderRow(_ title: String, value: Binding<Double>, range: ClosedRange<Double>,
                           step: Double, unit: String,
                           onRelease: @escaping () -> Void) -> some View {
        HStack {
            Text(title).frame(width: 80, alignment: .leading)
            Slider(value: value, in: range, step: step, onEditingChanged: { editing in
                if !editing { onRelease() }
            })
            Text("\(Int(value.wrappedValue))\(unit)")
                .monospacedDigit()
                .frame(width: 64, alignment: .trailing)
        }
    }
}

// MARK: - GATT + Log

struct GATTView: View {
    @EnvironmentObject var ble: BLEManager

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("GATT").font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4)
            ScrollView {
                Text(ble.gattDump)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
        }
    }
}

struct LogView: View {
    @EnvironmentObject var ble: BLEManager

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Log (\(ble.log.count)/\(BLEManager.logCap))").font(.caption).bold()
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(ble.logText, forType: .string)
                }
                Button("Clear") { ble.clearLog() }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(ble.logText)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                        Color.clear.frame(height: 1).id("log-bottom")
                    }
                }
                .onChange(of: ble.log.last?.id) { _ in
                    proxy.scrollTo("log-bottom", anchor: .bottom)
                }
                .onAppear {
                    proxy.scrollTo("log-bottom", anchor: .bottom)
                }
            }
        }
    }
}
