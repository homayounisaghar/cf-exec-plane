import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest

from wechat_file_send_dispatch import classify_receipt, validate_handoff, validate_target


class WeChatFileDispatchGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "in"
        self.root.mkdir(mode=0o700)
        self.run = self.root / "attempt"
        self.run.mkdir(mode=0o700)
        self.file = self.run / "probe.txt"
        self.data = b"qualification file\n"
        self.file.write_bytes(self.data)
        self.file.chmod(0o600)
        self.sha = hashlib.sha256(self.data).hexdigest()

    def validate(self, path=None, sha=None):
        return validate_handoff(str(path or self.file), sha or self.sha,
                                handoff_root=self.root, uid=os.getuid(), gid=os.getgid())

    def test_exact_private_handoff_passes(self):
        real, digest, size = self.validate()
        self.assertEqual(real, self.file.resolve())
        self.assertEqual(digest, self.sha)
        self.assertEqual(size, len(self.data))

    def test_hash_mismatch_fails(self):
        with self.assertRaisesRegex(RuntimeError, "SHA_MISMATCH"):
            self.validate(sha="f" * 64)

    def test_symlink_fails(self):
        link = self.run / "link.txt"
        link.symlink_to(self.file)
        with self.assertRaises(RuntimeError):
            self.validate(path=link)

    def test_wrong_file_mode_fails(self):
        self.file.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "NOT_PRIVATE"):
            self.validate()

    def test_hard_link_fails(self):
        other = self.run / "other.txt"
        os.link(self.file, other)
        with self.assertRaisesRegex(RuntimeError, "NOT_REGULAR"):
            self.validate()

    def test_wrong_parent_mode_fails(self):
        self.run.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "NOT_PRIVATE"):
            self.validate()

    def test_wrong_target_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "SELF_CHAT_ONLY"):
            validate_target("Other chat")
        validate_target("File Transfer")

    def test_ui_receipt_never_claims_provider_confirmation(self):
        r = classify_receipt(filename="probe.txt", before=[], after=["probe.txt 19B"],
                             direction="out", send_clicks=1, send_enabled_after=False)
        self.assertEqual(r["state"], "UI_OUTBOUND_OBSERVED")
        self.assertFalse(r["provider_confirmed"])
        self.assertFalse(r["blind_retry_safe"])

    def test_inbound_is_in_doubt(self):
        r = classify_receipt(filename="probe.txt", before=[], after=["probe.txt 19B"],
                             direction="in", send_clicks=1, send_enabled_after=False)
        self.assertEqual(r["state"], "IN_DOUBT")

    def test_missing_row_is_in_doubt(self):
        r = classify_receipt(filename="probe.txt", before=[], after=[],
                             direction="out", send_clicks=1, send_enabled_after=False)
        self.assertEqual(r["state"], "IN_DOUBT")

    def test_duplicate_row_is_in_doubt(self):
        r = classify_receipt(filename="probe.txt", before=[], after=["probe.txt", "probe.txt"],
                             direction="out", send_clicks=1, send_enabled_after=False)
        self.assertEqual(r["state"], "IN_DOUBT")

    def test_still_enabled_composer_is_in_doubt(self):
        r = classify_receipt(filename="probe.txt", before=[], after=["probe.txt"],
                             direction="out", send_clicks=1, send_enabled_after=True)
        self.assertEqual(r["state"], "IN_DOUBT")

    def test_unverified_direction_is_in_doubt(self):
        r = classify_receipt(filename="probe.txt", before=[], after=["probe.txt"],
                             direction="unknown", send_clicks=1, send_enabled_after=False)
        self.assertEqual(r["state"], "IN_DOUBT")

    def test_multiple_send_clicks_are_in_doubt(self):
        r = classify_receipt(filename="probe.txt", before=[], after=["probe.txt"],
                             direction="out", send_clicks=2, send_enabled_after=False)
        self.assertEqual(r["state"], "IN_DOUBT")


if __name__ == "__main__":
    unittest.main()
