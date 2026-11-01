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


    def test_verified_recent_followup_does_not_broaden_to_old_messengers(self):
        prior={"schema":"dexa.rolling-exchange-memory.v1",
               "exchangeSummaries":[
                   {"user":PAST,"status":"SUCCEEDED_VERIFIED",
                    "replyAvailable":True,"replyRefId":"old-ref"},
                   {"user":"آیا در وی‌چت پیام جدید دارم؟",
                    "status":"SUCCEEDED_VERIFIED","replyAvailable":True,
                    "replyRefId":"new-ref"}]}
        x=kata_rank.make("پیام‌های داخلش رو هم بخون",
                         tool_profile="telegram_readonly_mvp",
                         conversation_memory=prior,memory_rank_text=PAST)
        found={p for p in MESSENGERS if any(
            n.startswith("tool.cf."+p+"_") for n in x["capability_ids"])}
        self.assertEqual(found,{"wechat"})
        self.assertIn("tool.cf.wechat_message_list",x["capability_ids"])
        self.assertLess(len(x["capability_ids"]),60)

    def test_current_provider_overrides_context_provider(self):
        m={"schema":"dexa.rolling-exchange-memory.v1",
           "exchangeSummaries":[{"user":"آیا در وی‌چت پیام جدید دارم؟",
                "status":"SUCCEEDED_VERIFIED","replyAvailable":True,
                "replyRefId":"ok"}]}
        x=kata_rank.make("داخل واتساپ پیام‌ها رو بخون",
                         conversation_memory=m,memory_rank_text=PAST)
        self.assertIn("tool.cf.whatsapp_message_list",x["capability_ids"])
        self.assertNotIn("tool.cf.wechat_message_list",x["capability_ids"])

    def test_no_reference_or_unverified_last_reply_keeps_other_providers(self):
        m={"schema":"dexa.rolling-exchange-memory.v1",
           "exchangeSummaries":[{"user":"آیا در وی‌چت پیام جدید دارم؟",
                "status":"SUCCEEDED_VERIFIED","replyAvailable":True,
                "replyRefId":"ok"}]}
        broad=kata_rank.make("آیا پیام جدید دارم؟",
                             conversation_memory=m,memory_rank_text=PAST)
        self.assertIn("tool.cf.whatsapp_unread_list",broad["capability_ids"])
        for delta in ({"status":"FAILED"},{"replyAvailable":False},
                      {"replyRefId":None},
                      {"user":"توی وی‌چت و تلگرام پیام جدید دارم؟"}):
            memo={"schema":m["schema"],
                  "exchangeSummaries":[{**m["exchangeSummaries"][0],**delta}]}
            x=kata_rank.make("پیام‌های داخلش رو بخون",
                             conversation_memory=memo,memory_rank_text=PAST)
            self.assertIn("tool.cf.whatsapp_message_list",x["capability_ids"])

if __name__=="__main__":
    unittest.main()
