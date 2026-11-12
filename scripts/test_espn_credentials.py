import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from espn_credentials import load_credentials


class CredentialTests(unittest.TestCase):
    def test_local_values_quotes_and_comments(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / ".env"
            path.write_text('# Local only\nESPN_S2="test%2Bcookie=="\nSWID=\'{test-id}\' # comment\n')
            self.assertEqual(load_credentials(path), ("test%2Bcookie==", "{test-id}"))

    def test_environment_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"ESPN_S2": "env-cookie", "SWID": "{env-id}"}, clear=True,
        ):
            path = Path(directory) / ".env"
            path.write_text("ESPN_S2=local\nSWID={local}\n")
            self.assertEqual(load_credentials(path), ("env-cookie", "{env-id}"))
            self.assertEqual(load_credentials(path.parent / "missing"), ("env-cookie", "{env-id}"))

    def test_public_league_and_partial_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / ".env"
            self.assertEqual(load_credentials(path), (None, None))
            path.write_text("ESPN_S2=\nSWID=\n")
            self.assertEqual(load_credentials(path), (None, None))
            path.write_text("ESPN_S2=only-one\n")
            with self.assertRaisesRegex(ValueError, "both ESPN_S2 and SWID"):
                load_credentials(path)

    def test_invalid_input_never_echoes_values(self):
        for text in ['ESPN_S2="sensitive', "ESPN_S2=sensitive unquoted",
                     "ESPN_S2=sensitive\nESPN_S2=duplicate", "sensitive"]:
            with self.subTest(text=text), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, {}, clear=True):
                path = Path(directory) / ".env"
                path.write_text(text)
                with self.assertRaises(ValueError) as error:
                    load_credentials(path)
                self.assertNotIn("sensitive", str(error.exception))


if __name__ == "__main__":
    unittest.main()
