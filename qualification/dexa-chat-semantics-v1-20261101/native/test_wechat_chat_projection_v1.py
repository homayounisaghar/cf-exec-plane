import unittest
from wechat_semantic_helper_chooser_fixed_20261031 import parse_chat


class ChatProjection(unittest.TestCase):
    def parse(self, label, states=None):
        return parse_chat({"name":label, "states":states or []})

    def test_pinned_badge_removed_from_preview(self):
        c=self.parse("Kazem-tenghai\nPinned to top\nZ-YU: Message\n12:42")
        self.assertIs(c["pinned"],True)
        self.assertEqual(c["preview"],"Z-YU: Message")
        self.assertEqual(c["timestamp"],"12:42")

    def test_absence_is_unknown_not_false(self):
        c=self.parse("File Transfer\n[Video]\n12:40")
        self.assertIsNone(c["pinned"])
        self.assertEqual(c["preview"],"[Video]")

    def test_filter_success_only_for_verified_true(self):
        rows=[self.parse("P\nPinned to top\nHello\nToday"),
              self.parse("Q\nHello\nToday")]
        self.assertEqual([r["name"] for r in rows if r["pinned"] is True],["P"])

    def test_muted_unread_selected_stable(self):
        c=self.parse("Team\n[4]Welcome\nMute Notifications\nYesterday",["selected"])
        self.assertEqual(c["unread_count"],4)
        self.assertTrue(c["muted"])
        self.assertTrue(c["selected"])
        self.assertEqual(c["preview"],"Welcome")

    def test_combined_leading_statuses(self):
        c=self.parse("Team\nPinned to top\nMute Notifications\nHello\nToday")
        self.assertTrue(c["pinned"])
        self.assertTrue(c["muted"])
        self.assertEqual(c["preview"],"Hello")

    def test_message_substring_not_false_badge(self):
        c=self.parse("Team\nPinned to top is a feature\nToday")
        self.assertIsNone(c["pinned"])
        self.assertEqual(c["preview"],"Pinned to top is a feature")

    def test_middle_message_exact_label_not_badge(self):
        c=self.parse("Team\nHello\nPinned to top\n12:12")
        self.assertIsNone(c["pinned"])
        self.assertEqual(c["preview"],"Hello\nPinned to top")

    def test_lone_exact_label_not_proof(self):
        c=self.parse("Team\nPinned to top\nToday")
        self.assertIsNone(c["pinned"])
        self.assertEqual(c["preview"],"Pinned to top")

    def test_empty(self):
        self.assertIsNone(self.parse(""))


if __name__ == "__main__":
    unittest.main()
