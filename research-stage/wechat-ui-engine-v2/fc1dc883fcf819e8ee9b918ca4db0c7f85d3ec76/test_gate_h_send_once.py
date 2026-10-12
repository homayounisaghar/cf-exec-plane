"""Offline-only at-most-once Gate H safety regressions; NO live UI calls."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import os
os.environ["WX_GATE_F_TARGET"]="FixtureRecipient"
import gate_h_send_once as h
from engine import UIBlocked


class GateHSafety(unittest.TestCase):
    def _main_faked(self, *, flag=True, prior_attempt=False, pre_error=None,
                    draft_error=None, action_result=True, action_error=None,
                    post=None, cleaned=True):
        before=(8,("old",),Mock())
        post=post or ("SENT_VERIFIED","UI_OUTGOING_BUBBLE_VERIFIED",
                      {"selected":True,"composer_empty":True,
                       "send_disabled":True,"new_last":True,
                       "outgoing":True,"readable":True,"body_match":True})
        output=io.StringIO()
        calls={}
        with contextlib.ExitStack() as st:
            st.enter_context(patch.dict(os.environ,{
                "WX_GATE_H_SEND_ONCE":"1" if flag else "0",
                "WX_GATE_H_TEXT":"private-fixture-body",
                "WX_GATE_H_UNREAD_ZERO_VERIFIED":"1"}))
            st.enter_context(patch.object(h.f,"TARGET","FixtureRecipient"))
            st.enter_context(patch.object(h.sys,"stdout",output))
            for name in ("AtspiBackend","Session","UiPrimitives",
                         "_preflight","_draft_exact","_messages_snapshot",
                         "_send_button","_plan_activation","_claim_once",
                         "_activate_once","_verify_after_one_send"):
                calls[name]=st.enter_context(patch.object(h,name))
            calls["clipboard_clear"]=st.enter_context(
                patch.object(h.f,"clipboard_clear",return_value=cleaned))
            calls["cleanup_once"]=st.enter_context(
                patch.object(h.f,"cleanup_once",return_value=True))
            calls["which"]=st.enter_context(patch.object(
                h.f,"shutil_which",return_value="/usr/bin/test"))
            calls["instrument"]=st.enter_context(patch.object(
                h.f,"instrument_target_failures"))
            fakejournal=Mock()
            fakejournal.exists.return_value=prior_attempt
            calls["journal_path"]=st.enter_context(patch.object(
                h,"_journal_path",return_value=fakejournal))
            calls["_preflight"].return_value=before
            if pre_error: calls["_preflight"].side_effect=UIBlocked(pre_error)
            if draft_error: calls["_draft_exact"].side_effect=UIBlocked(draft_error)
            calls["_messages_snapshot"].return_value=before
            calls["_send_button"].return_value=Mock()
            calls["_plan_activation"].return_value=("AT_SPI_ACTION",Mock(),0)
            calls["_activate_once"].return_value=action_result
            if action_error: calls["_activate_once"].side_effect=action_error
            calls["_verify_after_one_send"].return_value=post
            calls["Session"].return_value.selected_conversation_name.return_value="FixtureRecipient"
            result=h.main()
            counts={key:m.call_count for key,m in calls.items()}
        return result,counts,output.getvalue()

    def test_missing_explicit_flag_never_attempts_send(self):
        rc,c,out=self._main_faked(flag=False)
        self.assertEqual(rc,2)
        self.assertEqual(c["_activate_once"],0)
        self.assertEqual(c["_claim_once"],0)
        self.assertEqual(c["_draft_exact"],0)
        self.assertIn("EXPLICIT_SEND_FLAG_REQUIRED",out)

    def test_prior_attempt_blocks_any_draft_or_send(self):
        rc,c,out=self._main_faked(prior_attempt=True)
        self.assertEqual(rc,2)
        for key in ("_preflight","_draft_exact","_claim_once","_activate_once"):
            self.assertEqual(c[key],0)
        self.assertIn("SEND_ALREADY_ATTEMPTED_NO_RETRY",out)

    def test_failed_preflight_never_drafts_or_sends(self):
        rc,c,out=self._main_faked(pre_error="RECIPIENT_NOT_ALREADY_SELECTED")
        self.assertEqual(rc,2)
        self.assertEqual(c["_draft_exact"],0)
        self.assertEqual(c["_claim_once"],0)
        self.assertEqual(c["_activate_once"],0)
        self.assertIn("RECIPIENT_NOT_ALREADY_SELECTED",out)

    def test_failed_draft_cleans_once_before_any_send(self):
        rc,c,out=self._main_faked(draft_error="DRAFT_CLIPBOARD_STAGING_FAILED")
        self.assertEqual(rc,2)
        self.assertEqual(c["_claim_once"],0)
        self.assertEqual(c["_activate_once"],0)
        self.assertEqual(c["cleanup_once"],1)
        self.assertIn("send_attempts=0",out)

    def test_only_one_activation_on_success(self):
        rc,c,out=self._main_faked()
        self.assertEqual(rc,0)
        self.assertEqual(c["_claim_once"],1)
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["_verify_after_one_send"],1)
        self.assertEqual(c["cleanup_once"],0)
        self.assertIn("status=SENT_VERIFIED",out)
        self.assertIn("send_attempts=1",out)
        self.assertNotIn("private-fixture-body",out)

    def test_action_false_is_in_doubt_without_retry_or_cleanup(self):
        rc,c,out=self._main_faked(action_result=False)
        self.assertEqual(rc,3)
        self.assertEqual(c["_claim_once"],1)
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["_verify_after_one_send"],0)
        self.assertEqual(c["cleanup_once"],0)
        self.assertIn("SINGLE_SEND_ACTION_RESULT_AMBIGUOUS",out)

    def test_action_exception_is_in_doubt_without_retry(self):
        rc,c,out=self._main_faked(action_error=RuntimeError("opaque"))
        self.assertEqual(rc,3)
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["cleanup_once"],0)
        self.assertIn("status=IN_DOUBT",out)
        self.assertNotIn("opaque",out)

    def test_no_outgoing_metadata_is_sent_unverified_not_verified(self):
        rc,c,out=self._main_faked(post=("SENT_UNVERIFIED",
                       "OUTGOING_DIRECTION_NOT_EXPOSED",
                       {"selected":True,"composer_empty":True,
                        "send_disabled":True,"new_last":True,
                        "outgoing":False,"readable":False,"body_match":False}))
        self.assertEqual(rc,3)
        self.assertEqual(c["_activate_once"],1)
        self.assertIn("status=SENT_UNVERIFIED",out)
        self.assertEqual(c["cleanup_once"],0)

    def test_clipboard_clear_uncertain_after_send_is_in_doubt(self):
        rc,c,out=self._main_faked(cleaned=False)
        self.assertEqual(rc,3)
        self.assertEqual(c["_activate_once"],1)
        self.assertIn("CLIPBOARD_CLEAR_UNVERIFIED",out)
        self.assertEqual(c["cleanup_once"],0)

    def test_permanent_journal_prevents_second_attempt_even_when_first_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertTrue(h._claim_once("FixtureRecipient","test",root=tmp))
            path=h._journal_path("FixtureRecipient","test",root=tmp)
            self.assertTrue(path.exists())
            self.assertNotIn("FixtureRecipient",path.name)
            self.assertNotIn("test",path.name)
            self.assertEqual(path.read_bytes(),b"ATTEMPTED_NO_RETRY\n")
            with self.assertRaises(UIBlocked) as err:
                h._claim_once("FixtureRecipient","test",root=tmp)
            self.assertEqual(err.exception.code,"SEND_ALREADY_ATTEMPTED_NO_RETRY")
            self.assertTrue(path.exists())

    def test_direct_action_is_invoked_once_no_fallback(self):
        action=Mock()
        action.do_action.return_value=False
        self.assertFalse(h._activate_once(("AT_SPI_ACTION",action,0)))
        action.do_action.assert_called_once_with(0)

    def test_hit_test_click_is_single_and_never_return(self):
        result=Mock(returncode=0)
        with patch.object(h.subprocess,"run",return_value=result) as runner:
            self.assertTrue(h._activate_once(("HIT_TEST_CLICK",200,300)))
        runner.assert_called_once()
        cmd=runner.call_args.args[0]
        self.assertEqual(cmd,("xdotool","mousemove","200","300","click","1"))
        self.assertNotIn("Return",cmd)
        self.assertNotIn("Enter",cmd)

    def test_action_preferred_over_hit_test_when_recognized(self):
        button=Mock()
        acc=Mock()
        action=Mock()
        acc.get_action_iface.return_value=action
        action.get_n_actions.return_value=1
        action.get_localized_name.return_value="click"
        backend=Mock()
        backend._find.return_value=acc
        plan=h._plan_activation(backend,button)
        self.assertEqual(plan[0],"AT_SPI_ACTION")
        self.assertEqual(plan[2],0)
        backend.hit_test.assert_not_called()

    def test_ambiguous_actions_refuse_before_send(self):
        action=Mock()
        action.get_n_actions.return_value=2
        action.get_localized_name.side_effect=["click","press"]
        backend=Mock()
        backend._find.return_value=Mock(get_action_iface=lambda:action)
        with self.assertRaises(UIBlocked) as err:
            h._plan_activation(backend,Mock())
        self.assertEqual(err.exception.code,"SEND_ACTION_AMBIGUOUS")
        backend.hit_test.assert_not_called()

    def test_bad_hit_test_refuses_before_send(self):
        from engine import Node,Rect
        button=Node((0,3),"button","Send",
                    frozenset(("visible","showing","enabled","sensitive")),
                    Rect(10,10,40,20))
        backend=Mock()
        action=Mock()
        action.get_n_actions.return_value=0
        backend._find.return_value=Mock(get_action_iface=lambda:action)
        backend.hit_test.return_value=None
        with self.assertRaises(UIBlocked) as err:
            h._plan_activation(backend,button)
        self.assertEqual(err.exception.code,"SEND_HIT_TEST_FAILED")

    def test_new_last_requires_new_identity_without_decrease(self):
        self.assertTrue(h._new_last((8,("old",),Mock()),(9,("new",),Mock())))
        self.assertFalse(h._new_last((8,("old",),Mock()),(8,("old",),Mock())))
        self.assertFalse(h._new_last((8,("old",),Mock()),(7,("new",),Mock())))

    def test_verify_outgoing_marker_but_unreadable_text_is_ui_only(self):
        backend=Mock()
        backend.snapshot.return_value=Mock()
        evidence={"selected":True,"composer_empty":True,
                  "send_disabled":True,"new_last":True,"outgoing":True,
                  "readable":False,"body_match":False}
        with patch.object(h,"_post_state",return_value=evidence):
            st,code,_=h._verify_after_one_send(backend,None,b"test",seconds=0.5)
        self.assertEqual(st,"SENT_VERIFIED")
        self.assertEqual(code,"UI_OUTGOING_BUBBLE_VERIFIED")
        backend.wait_change.assert_not_called()

    def test_verify_missing_outgoing_marker_unverified(self):
        backend=Mock()
        backend.snapshot.return_value=Mock()
        evidence={"selected":True,"composer_empty":True,
                  "send_disabled":True,"new_last":True,"outgoing":False,
                  "readable":True,"body_match":True}
        with patch.object(h,"_post_state",return_value=evidence):
            st,code,_=h._verify_after_one_send(backend,None,b"test",seconds=0.5)
        self.assertEqual(st,"SENT_UNVERIFIED")
        self.assertEqual(code,"OUTGOING_DIRECTION_NOT_EXPOSED")

    def test_verify_missing_composer_zero_is_in_doubt(self):
        backend=Mock()
        with patch.object(h,"_post_state",return_value={
                "selected":True,"composer_empty":False,
                "send_disabled":True,"new_last":True}),\
             patch.object(h.time,"monotonic",side_effect=[0,0.1,0.2,10.5]):
            st,code,_=h._verify_after_one_send(backend,None,b"test",seconds=10.0)
        self.assertEqual(st,"IN_DOUBT")
        self.assertEqual(code,"POSTCONDITION_COMPOSER_EMPTY_UNVERIFIED")

    def test_source_never_calls_backend_activate_or_return(self):
        import inspect
        src=inspect.getsource(h._activate_once)+inspect.getsource(h.main)
        self.assertNotIn("backend.activate(",src)
        self.assertNotIn('keyboard("Return")',src)
        self.assertNotIn('keyboard("Enter")',src)
        self.assertNotIn('key", "Return"',src)


    def _call_real_preflight(self, body, digest, *, unread_ok=True):
        import hashlib
        session=Mock()
        session.selected_conversation_name.return_value="FixtureRecipient"
        session.resolver.unique_conversation.return_value=Mock(
            states={"selected"})
        backend=Mock()
        state={
            "selected_expected":True,"chat_pane_open":True,
            "message_input_visible":True,"composer_toolbar_visible":True,
            "send_button_visible":True,"send_button_enabled":False,
        }
        vars={"WX_GATE_H_UNREAD_ZERO_VERIFIED":"1" if unread_ok else "0"}
        if digest is not None:
            vars["WX_GATE_H_EXPECTED_SHA256"]=digest
        with patch.dict(os.environ,vars,clear=True), \
             patch.object(h.sys,"argv",["gate_h","--unread-zero-verified"]), \
             patch.object(h.f,"TARGET","FixtureRecipient"), \
             patch.object(h,"UiPrimitives") as ui, \
             patch.object(h.f,"preflight") as normal_f, \
             patch.object(h.f,"_ui_state",return_value=state), \
             patch.object(h,"_messages_snapshot",return_value=("baseline",)) as msgs:
            result=h._preflight(backend,session,body)
            ui.return_value.require_no_modal.assert_called_once()
            normal_f.assert_called_once_with(backend,session)
            msgs.assert_called_once()
        return result

    def test_real_preflight_valid_ascii_passes_bytes_length(self):
        import hashlib
        body=b"single offline fixture"
        expected=hashlib.sha256(body).hexdigest()
        self.assertEqual(self._call_real_preflight(body,expected),("baseline",))

    def test_real_preflight_valid_persian_and_emoji_passes_bytes_length(self):
        import hashlib
        body="سلام دنیا 🙂".encode("utf8")
        expected=hashlib.sha256(body).hexdigest()
        self.assertEqual(self._call_real_preflight(body,expected),("baseline",))
        self.assertGreater(len(body),len(body.decode("utf8")))

    def test_real_preflight_rejects_leading_or_trailing_whitespace(self):
        import hashlib
        for body in (b" leading",b"trailing ",b"\nleading",b"trailing\n"):
            with self.subTest(whitespace_case=len(body)):
                with self.assertRaises(UIBlocked) as cm:
                    self._call_real_preflight(body,hashlib.sha256(body).hexdigest())
                self.assertEqual(cm.exception.code,"MESSAGE_ARGUMENT_INVALID")

    def test_real_preflight_rejects_too_long_bytes(self):
        import hashlib
        body=b"x"*1025
        with self.assertRaises(UIBlocked) as cm:
            self._call_real_preflight(body,hashlib.sha256(body).hexdigest())
        self.assertEqual(cm.exception.code,"MESSAGE_ARGUMENT_INVALID")

    def test_real_preflight_accepts_maximum_1024_bytes(self):
        import hashlib
        body=b"x"*1024
        self.assertEqual(self._call_real_preflight(body,hashlib.sha256(body).hexdigest()),("baseline",))

    def test_real_preflight_requires_digest_guard(self):
        body=b"fixture"
        with self.assertRaises(UIBlocked) as cm:
            self._call_real_preflight(body,None)
        self.assertEqual(cm.exception.code,"MESSAGE_HASH_GUARD_MISSING")

    def test_real_preflight_exact_digest_mismatch_fails_closed(self):
        body=b"fixture"
        with self.assertRaises(UIBlocked) as cm:
            self._call_real_preflight(body,"0"*64)
        self.assertEqual(cm.exception.code,"MESSAGE_EXACT_HASH_MISMATCH")

    def test_main_hash_mismatch_never_sends(self):
        rc,c,out=self._main_faked(pre_error="MESSAGE_EXACT_HASH_MISMATCH")
        self.assertEqual(rc,2)
        self.assertEqual(c["_draft_exact"],0)
        self.assertEqual(c["_claim_once"],0)
        self.assertEqual(c["_activate_once"],0)
        self.assertIn("MESSAGE_EXACT_HASH_MISMATCH",out)
        self.assertIn("send_attempts=0",out)

if __name__=="__main__":
    unittest.main()
