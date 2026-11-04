"""Build the updater manifest from the same notes file passed to GitHub."""

import json
from pathlib import Path
import sys


def write_manifest(out_path, version, notes_file, pub_date, target, signature, url):
    # Preserve newlines and Unicode exactly; JSON handles quotes and escaping.
    with open(notes_file, encoding="utf-8", newline="") as source:
        notes = source.read()
    if not notes.strip():
        raise ValueError("Release notes are empty")
    payload = {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": {target: {"signature": signature, "url": url}},
    }
    Path(out_path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    write_manifest(*sys.argv[1:])
