#!/bin/bash
# Serve the app on localhost (Web Bluetooth requires a secure context; localhost qualifies).
# Sends Cache-Control: no-cache so Chrome always revalidates and picks up edits.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8765}"
echo "Open in Chrome: http://localhost:${PORT}"
(sleep 1; open -a "Google Chrome" "http://localhost:${PORT}" 2>/dev/null) &
exec python3 -c '
import http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$PORT"
