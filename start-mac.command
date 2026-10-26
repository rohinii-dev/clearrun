#!/bin/bash
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then python3 run.py; else echo "Python 3 is not installed. Get it from https://www.python.org/downloads/"; read -p "Press Enter to close"; fi
