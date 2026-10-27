import SwiftUI

@main
struct GVMLightApp: App {
    @StateObject private var ble = BLEManager()

    var body: some Scene {
        WindowGroup("GVM Light") {
            ContentView()
                .environmentObject(ble)
                .frame(minWidth: 960, minHeight: 680)
        }
    }
}
