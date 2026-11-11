#!/usr/bin/env python3
"""Compatibility entry point; the single race suite lives in node:test."""
from pathlib import Path
import shutil
import subprocess
import sys

node = '/opt/homebrew/bin/node'
if not Path(node).exists():
    node = shutil.which('node')
if not node:
    sys.exit('Node.js is required to run the isolated PostgreSQL tests')
sys.exit(subprocess.call([node, '--test', str(Path(__file__).with_name('first-contact-snooze-postgres.test.mjs'))]))
