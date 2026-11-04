import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ReleaseManifestTests(unittest.TestCase):
    def test_cli_preserves_the_github_notes_file_and_download_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = '- Copy "tables" with ⌘C.\r\n\r\n- Use `/compact`.\r\n'
            source = root / "release notes.md"
            source.write_bytes(notes.encode("utf-8"))
            manifest = root / "latest.json"
            subprocess.run(
                [sys.executable, str(Path(__file__).with_name("release_manifest.py")),
                 str(manifest), "0.8.4", str(source), "2026-11-04T12:00:00Z",
                 "darwin-aarch64", "fixture-signature", "https://example.test/app.tar.gz"],
                check=True,
            )
            payload = json.loads(manifest.read_text())
            self.assertEqual(payload["notes"], source.read_bytes().decode("utf-8"))
            self.assertEqual(payload["version"], "0.8.4")
            self.assertEqual(payload["pub_date"], "2026-11-04T12:00:00Z")
            self.assertEqual(payload["platforms"], {
                "darwin-aarch64": {"signature": "fixture-signature",
                                    "url": "https://example.test/app.tar.gz"}
            })

    def test_empty_notes_do_not_write_a_manifest(self):
        from release_manifest import write_manifest

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "notes.md"
            source.write_text(" \n")
            manifest = Path(directory) / "latest.json"
            with self.assertRaisesRegex(ValueError, "empty"):
                write_manifest(manifest, "0.8.4", source, "date", "target", "sig", "url")
            self.assertFalse(manifest.exists())


if __name__ == "__main__":
    unittest.main()
