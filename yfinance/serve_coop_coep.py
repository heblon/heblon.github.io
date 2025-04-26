import http.server
import socketserver

PORT = 8080

class COOPCOEPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add COOP and COEP headers
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Call the parent class's end_headers method
        super().end_headers()

# Set up the server
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), COOPCOEPHandler) as httpd:
    print(f"Serving at http://localhost:{PORT} with COOP/COEP headers")
    print("Make sure duckdb-mvp.wasm and duckdb-browser-mvp.worker.js are in this directory.")
    httpd.serve_forever()
