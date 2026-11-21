"""Vercel ASGI entrypoint for NetViz.

Vercel imports the ``app`` object from this module. The project root is added to
``sys.path`` explicitly so the same application can run locally and inside the
Python serverless runtime.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Vercel's deployment bundle is read-only; /tmp is the only writable location.
os.environ.setdefault("NETVIZ_SERVERLESS", "1")
os.environ.setdefault("NETVIZ_DATABASE", "/tmp/netviz.db")
os.environ.setdefault("NETVIZ_HTTPS_ONLY", "1")

from app import app  # noqa: E402,F401
