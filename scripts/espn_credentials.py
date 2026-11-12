"""Load local ESPN cookies without importing the exporter or making requests."""

from __future__ import annotations

import os
import shlex
from pathlib import Path


def load_credentials(path: Path) -> tuple[str | None, str | None]:
    values = {}
    if path.exists():
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            key, separator, raw = line.partition("=")
            key = key.strip()
            if not separator or not key.isidentifier():
                raise ValueError(f"{path.name}:{line_number}: expected KEY=value")
            try:
                parts = shlex.split(raw, comments=True)
            except ValueError:
                raise ValueError(f"{path.name}:{line_number}: invalid quoting") from None
            if len(parts) > 1:
                raise ValueError(f"{path.name}:{line_number}: quote values containing spaces")
            if key in values:
                raise ValueError(f"{path.name}:{line_number}: duplicate variable")
            values[key] = parts[0] if parts else ""
    cookies = tuple(os.environ.get(key, values.get(key, "")) or None for key in ("ESPN_S2", "SWID"))
    if bool(cookies[0]) != bool(cookies[1]):
        raise ValueError("Private ESPN access requires both ESPN_S2 and SWID; set both or neither")
    return cookies[0], cookies[1]
