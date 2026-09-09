#!/bin/bash
# Double-click this file to serve the app at http://localhost:8777
cd "$(dirname "$0")" || exit 1
PORT=8777
echo "Zenith & Sky — Vending Location Intelligence"
echo "Serving $(pwd) at http://localhost:$PORT"
echo "Press Control-C to stop."
(sleep 1; open "http://localhost:$PORT/index.html") &
python3 -m http.server "$PORT"
