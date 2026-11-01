import unittest
import kata_rank,rank_v2

MESSENGERS={"telegram","whatsapp","bale","alibaba","wechat"}
PAST="توی تلگرام و واتساپ و بله و ویچت پیام دارم"
CASES={
"توی علی‌بابا پیام جدید دارم، آیا":{"alibaba"},
"توی واتساپ پیام جدید دارم، آیا":{"whatsapp"},
"توی بله پیام جدید دارم، آیا":{"bale"},
"توی تلگرام پیام جدید دارم، آیا":{"telegram"},
"توی ویچت پیام جدید دارم، آیا":{"wechat"},
"توی واتساپ و تلگرام پیام جدید دارم، آیا":{"whatsapp","telegram"},
}
class ProviderScope(unittest.TestCase):
    def names(self,mission):
        out=kata_rank.make(mission,previous_user_message=PAST)
        actual=set()
        for cid in out["capability_ids"]:
            for d in MESSENGERS:
                if cid.startswith(("tool.cf."+d+"_","telegram." if d=="telegram" else "zzzz")):
                    actual.add(d)
        return actual,out
    def test_current_owner_declared_provider_scope_overrides_old_context(self):
        for q,expected in CASES.items():
            with self.subTest(q=q):
                found,ranked=self.names(q)
                self.assertEqual(found,expected)
                self.assertLessEqual(len(ranked["capability_ids"]),65)
                self.assertEqual(rank_v2.domains(q)&MESSENGERS,expected)
    def test_no_explicit_provider_retains_cross_source_discovery(self):
        found,ranked=self.names("آیا پیام جدید دارم؟")
        self.assertGreater(len(found),1)
    def test_single_app_label_is_not_read_as_authorization_for_other_apps(self):
        _,out=self.names("توی علی‌بابا پیام جدید دارم، آیا")
        self.assertIn("tool.cf.alibaba_unread_list",out["capability_ids"])
        self.assertNotIn("tool.cf.whatsapp_unread_list",out["capability_ids"])
        self.assertNotIn("tool.cf.telegram_unread_list",out["capability_ids"])

if __name__=="__main__":
    unittest.main()
