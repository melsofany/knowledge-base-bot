import http.server
import socketserver
import threading
import os

PORT = int(os.environ.get("PORT", 8080))

class HealthCheckHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"OK")
    
    def do_POST(self):
        # Render sometimes sends POST to the root for health checks
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, format, *args):
        # Disable logging to keep console clean
        return

def run_health_check():
    with socketserver.TCPServer(("", PORT), HealthCheckHandler) as httpd:
        print(f"Health check server running on port {PORT}")
        httpd.serve_forever()

if __name__ == "__main__":
    # This allows running it standalone for testing
    run_health_check()
