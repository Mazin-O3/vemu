#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

PORT=8080
URL="http://localhost:$PORT/index.html"

PYTHON=$(command -v python3 || command -v python) || true
if [ -z "$PYTHON" ]; then
    echo "error: python not found in PATH" >&2
    exit 1
fi

port_pids() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti ":$PORT" 2>/dev/null || true
    elif command -v fuser >/dev/null 2>&1; then
        fuser "$PORT/tcp" 2>/dev/null || true
    else
        # Windows Git Bash: netstat.exe ships with every Windows install
        netstat -ano 2>/dev/null | \
            awk -v p=":$PORT\$" 'toupper($1)=="TCP" && $4=="LISTENING" && $2 ~ p {print $NF}' | sort -u
    fi
}

free_port() {
    local pids p
    pids=$(port_pids)
    [ -n "$pids" ] || return 0

    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(port_pids)
    [ -n "$pids" ] || return 0

    # Escalate: stopped (Ctrl+Z'd) servers ignore SIGTERM
    case "$(uname -s)" in
        CYGWIN*|MINGW*|MSYS*)
            for p in $pids; do
                taskkill //F //PID "$p" >/dev/null 2>&1 || kill -9 "$p" 2>/dev/null || true
            done
            ;;
        *)
            kill -9 $pids 2>/dev/null || true
            ;;
    esac
    sleep 0.5
}

open_browser() {
    case "$(uname -s)" in
        Darwin)
            open "$URL"
            ;;
        CYGWIN*|MINGW*|MSYS*)
            cmd.exe //c start "" "$URL" >/dev/null 2>&1 || explorer.exe "$URL"
            ;;
        *)
            xdg-open "$URL"
            ;;
    esac
}

case "${1:-}" in
    build)
        echo "Building WASM..."
        cargo build --release --target wasm32-unknown-unknown \
            --manifest-path Cargo.toml -p veewasm
        cp target/wasm32-unknown-unknown/release/veewasm.wasm veewasm.wasm
        ;;
    "")
        ;;
    *)
        echo "Usage: $0 [build]" >&2
        exit 1
        ;;
esac

echo "Starting server at $URL"
free_port

"$PYTHON" -c "
import http.server
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()
http.server.HTTPServer(('', $PORT), NoCacheHandler).serve_forever()
" &
SERVER_PID=$!

trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

open_browser || true
wait $SERVER_PID
