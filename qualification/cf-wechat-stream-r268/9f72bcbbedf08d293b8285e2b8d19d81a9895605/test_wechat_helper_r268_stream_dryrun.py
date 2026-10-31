import base64
import hashlib
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "wechat_helper_r268", HERE / "wechat_semantic_helper_r268_stream_dryrun.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

DATA = b"Owner-self WeChat file handoff dry-run only.\n"
DIGEST = hashlib.sha256(DATA).hexdigest()


class DryRunOnlyTests(unittest.TestCase):
    def call(self, **changes):
        args = {"target": "File Transfer", "filename": "safe.txt",
                "data_base64": base64.b64encode(DATA).decode("ascii"),
                "expected_sha256": DIGEST, "allow_mark_read": False,
                "dry_run": True}
        args.update(changes)
        return mod.file_send(**args)

    def test_valid_bytes_qualify_chooser_then_cleanup_without_send(self):
        root = pathlib.Path("/tmp/wxeng/in")
        existing = set(p.name for p in root.iterdir())
        control = {"open": False, "actions": []}

        def activate(_):
            control["actions"].append("send_file_button")
            control["open"] = True

        def xdotool(*argv):
            control["actions"].append(tuple(argv))
            if argv == ("key", "Escape"):
                control["open"] = False

        with (
            patch.object(mod, "tree_rows", return_value=[]),
            patch.object(mod, "authenticated", return_value=True),
            patch.object(mod, "select_target", return_value={"selected": True}),
            patch.object(mod, "find_visible_button_exact", return_value=object()),
            patch.object(mod, "activate_object", side_effect=activate),
            patch.object(mod, "file_dialog_state", side_effect=lambda: {
                "is_distinct_file_dialog_candidate": control["open"]
            }),
            patch.object(mod, "xdotool", side_effect=xdotool),
        ):
            result = self.call()
        self.assertEqual(result["state"], "DRY_RUN_READY")
        self.assertTrue(result["private_bytes_verified"])
        self.assertFalse(result["effect_performed"])
        self.assertFalse(result["provider_send_performed"])
        self.assertEqual(result["sha256_hex"], DIGEST)
        self.assertEqual(control["actions"], [
            "send_file_button", ("key", "Escape")
        ])
        self.assertEqual({p.name for p in root.iterdir()}, existing)

    def test_live_send_fails_before_ui_or_file_staging(self):
        with self.assertRaisesRegex(RuntimeError, "LIVE_SEND_DISABLED"):
            self.call(dry_run=False)

    def test_wrong_recipient_fails(self):
        with self.assertRaisesRegex(RuntimeError, "SCOPE_INVALID"):
            self.call(target="Other")

    def test_mark_read_fails(self):
        with self.assertRaisesRegex(RuntimeError, "SCOPE_INVALID"):
            self.call(allow_mark_read=True)

    def test_incorrect_digest_fails(self):
        with self.assertRaisesRegex(RuntimeError, "SHA_MISMATCH"):
            self.call(expected_sha256="a" * 64)

    def test_invalid_base64_fails(self):
        with self.assertRaisesRegex(RuntimeError, "BASE64_INVALID"):
            self.call(data_base64="???")

    def test_oversized_data_fails(self):
        large = b"x" * (131072 + 1)
        with self.assertRaisesRegex(RuntimeError, "BYTES_OVER_LIMIT|SIZE_INVALID"):
            self.call(data_base64=base64.b64encode(large).decode("ascii"))

    def test_directory_escape_fails(self):
        with self.assertRaisesRegex(RuntimeError, "FILENAME_INVALID"):
            self.call(filename="../escape")

    def test_no_zero_bytes(self):
        with self.assertRaisesRegex(RuntimeError, "SIZE_INVALID"):
            self.call(data_base64=base64.b64encode(b"").decode("ascii"),
                      expected_sha256=hashlib.sha256(b"").hexdigest())


if __name__ == "__main__":
    unittest.main()
