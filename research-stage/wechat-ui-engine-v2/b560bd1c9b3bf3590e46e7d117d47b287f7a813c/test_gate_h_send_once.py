"""Offline-only Gate H safety regressions (owner-authored). NO live UI calls.

Covers: explicit flag, one-shot lockout + owner-attested single reset,
durable pre-click fingerprint, exact hit-test, hover-only X11 pointer mapping,
at most ONE click, no AT-SPI action path, no Return, no retry, privacy.
"""
import contextlib
import hashlib
import inspect
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

os.environ["WX_GATE_F_TARGET"]="FixtureRecipient"
import gate_h_send_once as h
from engine import Node, Rect, UIBlocked

ST=frozenset(("visible","showing","enabled","sensitive"))
OK_POST=("SENT_VERIFIED","UI_OUTGOING_BUBBLE_VERIFIED",
         {"selected":True,"composer_empty":True,"send_disabled":True,
          "new_last":True,"outgoing":True,"readable":True,"body_match":True})


def _button():
    return Node((0,3),"button","Send",ST,Rect(10,10,40,20))


def _before():
    last=Node((0,5,7),"list item","fixture-bubble-text",ST,Rect(0,0,10,10))
    ident=(last.path,last.role,hashlib.sha256(last.name.encode("utf8")).digest())
    return (8,ident,last)


class MainFlow(unittest.TestCase):
    def run_main(self,*,flag=True,attempt_error=None,pre_error=None,draft_error=None,
                 hit_error=None,map_error=None,claim_error=None,action_result=True,
                 action_error=None,post=OK_POST,cleaned=True):
        out=io.StringIO()
        order=[]
        before=(8,("old",),Mock())
        with contextlib.ExitStack() as st:
            st.enter_context(patch.dict(os.environ,{
                "WX_GATE_H_SEND_ONCE":"1" if flag else "0",
                "WX_GATE_H_TEXT":"private-fixture-body",
                "WX_GATE_H_UNREAD_ZERO_VERIFIED":"1"}))
            st.enter_context(patch.object(h.f,"TARGET","FixtureRecipient"))
            st.enter_context(patch.object(h.sys,"stdout",out))
            m={}
            for name in ("AtspiBackend","Session","UiPrimitives","_preflight",
                         "_draft_exact","_messages_snapshot","_send_button",
                         "_main_frame_rect","_plan_activation","_verify_pointer_mapping",
                         "_claim_once","_activate_once","_verify_after_one_send",
                         "_attempt_path"):
                m[name]=st.enter_context(patch.object(h,name))
            m["clipboard_clear"]=st.enter_context(patch.object(h.f,"clipboard_clear",return_value=cleaned))
            m["cleanup_once"]=st.enter_context(patch.object(h.f,"cleanup_once",return_value=True))
            st.enter_context(patch.object(h.f,"shutil_which",return_value="/usr/bin/test"))
            st.enter_context(patch.object(h.f,"instrument_target_failures"))
            m["Session"].return_value.selected_conversation_name.return_value="FixtureRecipient"
            m["_preflight"].return_value=before
            m["_messages_snapshot"].return_value=before
            m["_plan_activation"].return_value=("HIT_TEST_CLICK",30,20)
            if attempt_error: m["_attempt_path"].side_effect=UIBlocked(attempt_error)
            if pre_error: m["_preflight"].side_effect=UIBlocked(pre_error)
            if draft_error: m["_draft_exact"].side_effect=UIBlocked(draft_error)
            if hit_error: m["_plan_activation"].side_effect=UIBlocked(hit_error)
            if map_error: m["_verify_pointer_mapping"].side_effect=UIBlocked(map_error)
            m["_claim_once"].side_effect=(UIBlocked(claim_error) if claim_error
                                          else lambda *a,**k: order.append("claim") or True)
            def act(plan):
                order.append("click")
                if action_error: raise action_error
                return action_result
            m["_activate_once"].side_effect=act
            m["_verify_after_one_send"].return_value=post
            rc=h.main()
            counts={k:v.call_count for k,v in m.items()}
        return rc,counts,out.getvalue(),order

    def test_missing_flag_never_drafts_or_clicks(self):
        rc,c,out,_=self.run_main(flag=False)
        self.assertEqual(rc,2)
        for k in ("_draft_exact","_claim_once","_activate_once"): self.assertEqual(c[k],0)
        self.assertIn("EXPLICIT_SEND_FLAG_REQUIRED",out)

    def test_lockout_blocks_before_any_gui_effect(self):
        rc,c,out,_=self.run_main(attempt_error="SEND_ALREADY_ATTEMPTED_NO_RETRY")
        self.assertEqual(rc,2)
        for k in ("AtspiBackend","_preflight","_draft_exact","_claim_once","_activate_once"):
            self.assertEqual(c[k],0)
        self.assertIn("SEND_ALREADY_ATTEMPTED_NO_RETRY",out)

    def test_failed_preflight_never_drafts_or_clicks(self):
        rc,c,out,_=self.run_main(pre_error="RECIPIENT_NOT_ALREADY_SELECTED")
        self.assertEqual(rc,2)
        for k in ("_draft_exact","_claim_once","_activate_once"): self.assertEqual(c[k],0)

    def test_hash_mismatch_never_clicks(self):
        rc,c,out,_=self.run_main(pre_error="MESSAGE_EXACT_HASH_MISMATCH")
        self.assertEqual(rc,2)
        self.assertEqual(c["_activate_once"],0)
        self.assertIn("send_attempts=0",out)

    def test_failed_draft_cleans_once_never_clicks(self):
        rc,c,out,_=self.run_main(draft_error="DRAFT_CLIPBOARD_STAGING_FAILED")
        self.assertEqual(rc,2)
        self.assertEqual(c["_activate_once"],0)
        self.assertEqual(c["cleanup_once"],1)

    def test_hit_test_failure_cleans_never_claims_or_clicks(self):
        rc,c,out,_=self.run_main(hit_error="SEND_HIT_TEST_FAILED")
        self.assertEqual(rc,2)
        self.assertEqual(c["_claim_once"],0)
        self.assertEqual(c["_activate_once"],0)
        self.assertEqual(c["cleanup_once"],1)
        self.assertIn("SEND_HIT_TEST_FAILED",out)

    def test_pointer_mapping_failure_cleans_never_claims_or_clicks(self):
        rc,c,out,_=self.run_main(map_error="POINTER_MAPPING_UNVERIFIED")
        self.assertEqual(rc,2)
        self.assertEqual(c["_claim_once"],0)
        self.assertEqual(c["_activate_once"],0)
        self.assertEqual(c["cleanup_once"],1)
        self.assertIn("POINTER_MAPPING_UNVERIFIED",out)

    def test_claim_failure_never_clicks(self):
        rc,c,out,order=self.run_main(claim_error="JOURNAL_CLAIM_FAILED")
        self.assertEqual(rc,2)
        self.assertEqual(c["_activate_once"],0)
        self.assertEqual(order,[])

    def test_success_exactly_one_click_after_claim(self):
        rc,c,out,order=self.run_main()
        self.assertEqual(rc,0)
        self.assertEqual(order,["claim","click"])
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["_verify_after_one_send"],1)
        self.assertEqual(c["cleanup_once"],0)
        self.assertIn("status=SENT_VERIFIED",out)
        self.assertIn("send_attempts=1",out)
        self.assertNotIn("private-fixture-body",out)

    def test_click_false_in_doubt_no_retry_no_cleanup(self):
        rc,c,out,order=self.run_main(action_result=False)
        self.assertEqual(rc,3)
        self.assertEqual(order,["claim","click"])
        self.assertEqual(c["_verify_after_one_send"],0)
        self.assertEqual(c["cleanup_once"],0)
        self.assertIn("SINGLE_SEND_ACTION_RESULT_AMBIGUOUS",out)

    def test_click_exception_in_doubt_no_retry(self):
        rc,c,out,_=self.run_main(action_error=RuntimeError("opaque"))
        self.assertEqual(rc,3)
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["cleanup_once"],0)
        self.assertNotIn("opaque",out)

    def test_sent_unverified_exit3_no_cleanup(self):
        post=("SENT_UNVERIFIED","OUTGOING_DIRECTION_NOT_EXPOSED",dict(OK_POST[2],outgoing=False))
        rc,c,out,_=self.run_main(post=post)
        self.assertEqual(rc,3)
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["cleanup_once"],0)

    def test_postcondition_in_doubt_exit3_single_click(self):
        post=("IN_DOUBT","POSTCONDITION_COMPOSER_EMPTY_UNVERIFIED",dict(OK_POST[2],composer_empty=False))
        rc,c,out,_=self.run_main(post=post)
        self.assertEqual(rc,3)
        self.assertEqual(c["_activate_once"],1)
        self.assertEqual(c["cleanup_once"],0)

    def test_clipboard_uncertain_after_send_in_doubt(self):
        rc,c,out,_=self.run_main(cleaned=False)
        self.assertEqual(rc,3)
        self.assertIn("CLIPBOARD_CLEAR_UNVERIFIED",out)


class Journal(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=self.tmp.name
        self.plan=("HIT_TEST_CLICK",30,20)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_prior(self,content=b"ATTEMPTED_NO_RETRY\n",mode=0o600):
        p=h._journal_path("FixtureRecipient","body",root=self.root)
        p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        p.write_bytes(content); os.chmod(p,mode)
        return p

    def _claim(self,reset):
        with patch.object(h.sys,"stdout",io.StringIO()):
            return h._claim_once("FixtureRecipient","body",_before(),self.plan,
                                 root=self.root,reset=reset)

    def test_first_claim_writes_durable_fingerprint_and_blocks_second(self):
        self.assertTrue(self._claim(False))
        p=h._journal_path("FixtureRecipient","body",root=self.root)
        rec=json.loads(p.read_text())
        self.assertEqual(rec["schema"],"wechat-gate-h-preclick-v1")
        self.assertEqual(rec["visible_message_count"],8)
        self.assertEqual(rec["method"],"HIT_TEST_CLICK")
        self.assertEqual(oct(p.stat().st_mode & 0o777),"0o600")
        with self.assertRaises(UIBlocked) as e: self._claim(False)
        self.assertEqual(e.exception.code,"SEND_ALREADY_ATTEMPTED_NO_RETRY")

    def test_fingerprint_contains_no_text_or_recipient(self):
        self._claim(False)
        p=h._journal_path("FixtureRecipient","body",root=self.root)
        raw=p.read_text()
        self.assertNotIn("fixture-bubble-text",raw)
        self.assertNotIn("FixtureRecipient",raw+p.name)
        self.assertNotIn('"body"',raw)

    def test_prior_marker_without_reset_blocks(self):
        self._write_prior()
        with self.assertRaises(UIBlocked) as e: self._claim(False)
        self.assertEqual(e.exception.code,"SEND_ALREADY_ATTEMPTED_NO_RETRY")

    def test_owner_reset_allows_exactly_one_new_attempt(self):
        prior=self._write_prior()
        self.assertTrue(self._claim(True))
        new=h._reset_attempt_path("FixtureRecipient","body",root=self.root)
        self.assertTrue(new.exists())
        self.assertEqual(prior.read_bytes(),b"ATTEMPTED_NO_RETRY\n")  # history kept
        with self.assertRaises(UIBlocked) as e: self._claim(True)
        self.assertEqual(e.exception.code,"SEND_ALREADY_ATTEMPTED_NO_RETRY")
        with self.assertRaises(UIBlocked): self._claim(False)

    def test_reset_requires_valid_prior_marker(self):
        with self.assertRaises(UIBlocked) as e: self._claim(True)
        self.assertEqual(e.exception.code,"RESET_PRIOR_MARKER_UNVERIFIED")

    def test_reset_rejects_tampered_or_open_prior_marker(self):
        self._write_prior(content=b"something else\n")
        with self.assertRaises(UIBlocked) as e: self._claim(True)
        self.assertEqual(e.exception.code,"RESET_PRIOR_MARKER_UNVERIFIED")
        self._write_prior(mode=0o644)
        with self.assertRaises(UIBlocked) as e: self._claim(True)
        self.assertEqual(e.exception.code,"RESET_PRIOR_MARKER_UNVERIFIED")

    def test_bad_baseline_or_plan_blocks_before_marker(self):
        with patch.object(h.sys,"stdout",io.StringIO()):
            with self.assertRaises(UIBlocked):
                h._claim_once("FixtureRecipient","body",(8,("x",),_before()[2]),self.plan,root=self.root,reset=False)
            with self.assertRaises(UIBlocked):
                h._claim_once("FixtureRecipient","body",_before(),("AT_SPI_ACTION",1,0),root=self.root,reset=False)
        self.assertFalse(h._journal_path("FixtureRecipient","body",root=self.root).exists())


class Activation(unittest.TestCase):
    def test_non_click_plan_refused_without_side_effect(self):
        with patch.object(h.subprocess,"run") as run:
            with self.assertRaises(UIBlocked) as e:
                h._activate_once(("AT_SPI_ACTION",Mock(),0))
        self.assertEqual(e.exception.code,"SEND_ACTIVATION_METHOD_UNAVAILABLE")
        run.assert_not_called()

    def test_click_is_single_xdotool_call_never_return(self):
        with patch.object(h.subprocess,"run",return_value=Mock(returncode=0)) as run, \
             patch.object(h.sys,"stdout",io.StringIO()):
            self.assertTrue(h._activate_once(("HIT_TEST_CLICK",200,300)))
        run.assert_called_once()
        cmd=run.call_args.args[0]
        self.assertEqual(cmd,("xdotool","mousemove","200","300","click","1"))
        self.assertNotIn("Return",cmd); self.assertNotIn("key",cmd)

    def test_plan_exact_hit_uses_pointer_only(self):
        b=_button(); backend=Mock(); backend.hit_test.return_value=b
        with patch.object(h.sys,"stdout",io.StringIO()):
            self.assertEqual(h._plan_activation(backend,b),("HIT_TEST_CLICK",30,20))
        backend.hit_test.assert_called_once_with(30,20)
        backend._find.assert_not_called()

    def test_plan_rejects_other_node_none_or_moved_rect(self):
        b=_button()
        for hit in (Node((0,4),"button","Send",ST,b.rect), None,
                    Node((0,3),"button","Send",ST,Rect(11,10,40,20))):
            backend=Mock(); backend.hit_test.return_value=hit
            with patch.object(h.sys,"stdout",io.StringIO()):
                with self.assertRaises(UIBlocked) as e: h._plan_activation(backend,b)
            self.assertEqual(e.exception.code,"SEND_HIT_TEST_FAILED")
            backend._find.assert_not_called()


class PointerMapping(unittest.TestCase):
    def fake(self,loc,geo,move_rc=0):
        calls=[]
        def run(cmd,**kw):
            calls.append(cmd)
            if cmd[1]=="mousemove": return Mock(returncode=move_rc,stdout=b"")
            if cmd[1]=="getmouselocation": return Mock(returncode=0,stdout=loc)
            if cmd[1]=="getwindowgeometry": return Mock(returncode=0,stdout=geo)
            raise AssertionError(cmd)
        return run,calls

    def check(self,loc,geo,frame=Rect(100,50,880,640),move_rc=0):
        run,calls=self.fake(loc,geo,move_rc)
        with patch.object(h.subprocess,"run",side_effect=run), \
             patch.object(h.sys,"stdout",io.StringIO()):
            try:
                return h._verify_pointer_mapping(("HIT_TEST_CLICK",300,400),frame),calls
            except UIBlocked as e:
                return e.code,calls

    GOOD_LOC=b"X=300\nY=400\nSCREEN=0\nWINDOW=4194310\n"
    GOOD_GEO=b"WINDOW=4194310\nX=100\nY=50\nWIDTH=880\nHEIGHT=640\nSCREEN=0\n"

    def test_match_passes_and_never_clicks(self):
        res,calls=self.check(self.GOOD_LOC,self.GOOD_GEO)
        self.assertIs(res,True)
        self.assertEqual(calls[0],("xdotool","mousemove","300","400"))
        for c in calls:
            self.assertNotIn("click",c); self.assertNotIn("key",c)

    def test_small_tolerance_passes(self):
        res,_=self.check(self.GOOD_LOC,b"X=101\nY=49\nWIDTH=882\nHEIGHT=640\n")
        self.assertIs(res,True)

    def test_pointer_not_at_target_blocks(self):
        res,_=self.check(b"X=310\nY=400\nWINDOW=1\n",self.GOOD_GEO)
        self.assertEqual(res,"POINTER_MAPPING_UNVERIFIED")

    def test_window_offset_mismatch_blocks(self):
        res,_=self.check(self.GOOD_LOC,b"X=0\nY=0\nWIDTH=880\nHEIGHT=640\n")
        self.assertEqual(res,"POINTER_MAPPING_UNVERIFIED")

    def test_xdotool_failure_blocks(self):
        res,_=self.check(self.GOOD_LOC,self.GOOD_GEO,move_rc=1)
        self.assertEqual(res,"POINTER_MAPPING_UNVERIFIED")

    def test_missing_frame_or_bad_plan_blocks(self):
        with patch.object(h.subprocess,"run") as run, patch.object(h.sys,"stdout",io.StringIO()):
            for plan,frame in ((("HIT_TEST_CLICK",1,2),None),(("AT_SPI_ACTION",1,2),Rect(0,0,1,1))):
                with self.assertRaises(UIBlocked): h._verify_pointer_mapping(plan,frame)
        run.assert_not_called()


class Verify(unittest.TestCase):
    def test_new_last_identity_rules(self):
        self.assertTrue(h._new_last((8,("old",),Mock()),(9,("new",),Mock())))
        self.assertFalse(h._new_last((8,("old",),Mock()),(8,("old",),Mock())))
        self.assertFalse(h._new_last((8,("old",),Mock()),(7,("new",),Mock())))

    def test_verified_when_all_conditions_true(self):
        backend=Mock()
        with patch.object(h,"_post_state",return_value=OK_POST[2]):
            st,code,_=h._verify_after_one_send(backend,None,b"x",seconds=0.5)
        self.assertEqual((st,code),("SENT_VERIFIED","UI_OUTGOING_BUBBLE_VERIFIED"))

    def test_missing_outgoing_is_unverified(self):
        with patch.object(h,"_post_state",return_value=dict(OK_POST[2],outgoing=False)):
            st,code,_=h._verify_after_one_send(Mock(),None,b"x",seconds=0.5)
        self.assertEqual((st,code),("SENT_UNVERIFIED","OUTGOING_DIRECTION_NOT_EXPOSED"))

    def test_composer_not_empty_is_in_doubt_and_never_clicks(self):
        backend=Mock()
        with patch.object(h,"_post_state",return_value=dict(OK_POST[2],composer_empty=False)), \
             patch.object(h.time,"monotonic",side_effect=[0,0.1,0.2,10.5]), \
             patch.object(h,"_activate_once") as act:
            st,code,_=h._verify_after_one_send(backend,None,b"x",seconds=10.0)
        self.assertEqual((st,code),("IN_DOUBT","POSTCONDITION_COMPOSER_EMPTY_UNVERIFIED"))
        act.assert_not_called()


class Preflight(unittest.TestCase):
    def call(self,body,digest):
        session=Mock()
        session.selected_conversation_name.return_value="FixtureRecipient"
        session.resolver.unique_conversation.return_value=Mock(states={"selected"})
        state={"selected_expected":True,"chat_pane_open":True,"message_input_visible":True,
               "composer_toolbar_visible":True,"send_button_visible":True,"send_button_enabled":False}
        env={"WX_GATE_H_UNREAD_ZERO_VERIFIED":"1"}
        if digest is not None: env["WX_GATE_H_EXPECTED_SHA256"]=digest
        with patch.dict(os.environ,env,clear=True), \
             patch.object(h.sys,"argv",["gate_h","--unread-zero-verified"]), \
             patch.object(h.f,"TARGET","FixtureRecipient"), \
             patch.object(h,"UiPrimitives"), patch.object(h.f,"preflight"), \
             patch.object(h.f,"_ui_state",return_value=state), \
             patch.object(h,"_messages_snapshot",return_value=("baseline",)):
            return h._preflight(Mock(),session,body)

    def test_persian_emoji_exact_digest_passes(self):
        body="این پیام آزمایشی است 🙂".encode("utf8")
        self.assertEqual(self.call(body,hashlib.sha256(body).hexdigest()),("baseline",))

    def test_whitespace_or_too_long_rejected(self):
        for body in (b" a",b"a ",b"\na",b"x"*1025):
            with self.assertRaises(UIBlocked) as e: self.call(body,hashlib.sha256(body).hexdigest())
            self.assertEqual(e.exception.code,"MESSAGE_ARGUMENT_INVALID")

    def test_digest_missing_or_mismatch_rejected(self):
        with self.assertRaises(UIBlocked) as e: self.call(b"fixture",None)
        self.assertEqual(e.exception.code,"MESSAGE_HASH_GUARD_MISSING")
        with self.assertRaises(UIBlocked) as e: self.call(b"fixture","0"*64)
        self.assertEqual(e.exception.code,"MESSAGE_EXACT_HASH_MISMATCH")


class Source(unittest.TestCase):
    def test_no_action_or_return_path_anywhere(self):
        src=inspect.getsource(h)
        for bad in ("do_action(","backend.activate(",'keyboard("Return")','keyboard("Enter")',
                    '"key","Return"','"key", "Return"',"KP_Enter"):
            self.assertNotIn(bad,src)

    def test_only_one_click_site_in_module(self):
        src=inspect.getsource(h)
        self.assertEqual(src.count('"click"'),1)
        self.assertIn('"click","1"',inspect.getsource(h._activate_once))


if __name__=="__main__":
    unittest.main()
