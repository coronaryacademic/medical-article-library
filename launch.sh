#!/bin/bash
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"
cd "/home/momen/.gemini/antigravity/scratch/medical-article-library"

echo "======================================================="
echo "  UW Medical Article Library Host Backend Server      "
echo "======================================================="

# Check if server is already running on port 8088
if curl -s http://localhost:8088/api/catalog > /dev/null 2>&1; then
    echo "[!] UW Library Server is ALREADY RUNNING on http://localhost:8088"
    echo "[+] Opening browser..."
    /usr/bin/xdg-open "http://localhost:8088"
    echo "======================================================="
    sleep 3
    exit 0
fi

# If port 8088 is stuck by another process, free it
fuser -k 8088/tcp > /dev/null 2>&1 || true
sleep 0.5

echo "[+] Starting Node.js Host Server on http://localhost:8088..."
(sleep 1.2 && /usr/bin/xdg-open "http://localhost:8088") &

/usr/bin/node server.js
