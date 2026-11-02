#!/usr/bin/env python3
"""Pure regression tests: invented names, no real messages or external sends."""
import os
import unittest
os.environ["DEXA_TOOL_PLAN_V3"] = "1"
import kata_rank

NAME = "Lantern-Forge"
OWNER = "Show my 10 latest WeChat chats"
REPLY = "• Lantern-Forge • North Bridge (1 unread) • Mock Supplier"
def memory(status="SUCCEEDED_VERIFIED"):
    return {"schema":"dexa.rolling-exchange-memory.v1",
      "exchangeSummaries":[{"user":OWNER,"reply":REPLY,
       "status":status,"replyAvailable":True,"replyRefId":"synthetic-ref"}]}
def count(result,provider):
    return sum(x.startswith("tool.cf."+provider+"_") for x in result["capability_ids"])

class VerifiedPreviousListScope(unittest.TestCase):
    def test_named_chat_from_verified_list_uses_observed_previous_provider(self):
        result=kata_rank.make("What is the latest message in Lantern-Forge chat?",
          conversation_memory=memory(),
          memory_rank_text=OWNER+" | "+REPLY)
        self.assertIn("tool.cf.wechat_message_list",result["capability_ids"])
        self.assertIn("tool.cf.wechat_conversation_list",result["capability_ids"])
        for unrelated in ("telegram","whatsapp","alibaba","bale"):
            self.assertEqual(count(result,unrelated),0)
        self.assertLess(result["selected_count"],60)
    def test_unrelated_name_does_not_claim_previous_provider(self):
        self.assertFalse(kata_rank.verified_prior_bullet_title_in_owner_task(
            "What is the latest message in Some Stranger chat?",REPLY))
    def test_forged_or_failed_previous_list_cannot_scope(self):
        result=kata_rank.make("What is the latest message in Lantern-Forge chat?",
          conversation_memory=memory("FAILED"),
          memory_rank_text=OWNER+" | "+REPLY)
        self.assertGreater(count(result,"telegram")+count(result,"whatsapp")+count(result,"bale"),0)
    def test_explicit_different_provider_wins(self):
        result=kata_rank.make("What is the latest message in Telegram chat Lantern-Forge?",
          conversation_memory=memory(),
          memory_rank_text=OWNER+" | "+REPLY)
        self.assertEqual(count(result,"wechat"),0)
        self.assertGreater(count(result,"telegram"),0)
    def test_exact_title_boundary_not_prefix(self):
        self.assertFalse(kata_rank.verified_prior_bullet_title_in_owner_task(
            "latest message in Lantern-ForgeX chat?",REPLY))
        self.assertTrue(kata_rank.verified_prior_bullet_title_in_owner_task(
            "latest message in Lantern-Forge chat?",REPLY))
if __name__=="__main__":
    unittest.main()
