"""Pure offline safety tests: no original client, no keyboard/clipboard calls."""
import unittest
import os
os.environ['WX_GATE_F_TARGET']='FixtureRecipient'
from unittest.mock import patch, Mock
import benchmark_gate_f_readsafe as m
from engine import UIBlocked

class FakeEditor:
    def __init__(self, count):
        self.count = count
    def get_character_count(self):
        return self.count
class FakeObject:
    def __init__(self,count):
        self.count=count
    def get_text_iface(self):
        return FakeEditor(self.count)
class FakeB:
    def __init__(self,count):
        self.count=count
        self.focus_calls=0
    def focus(self,n):
        self.focus_calls+=1
        return True
    def _find(self,n):
        return FakeObject(self.count)
    def _states(self,n):
        return {"focused"}
class FakeResolver:
    def __init__(self):
        self.invalidations=0
        self.composer_text=""
    def refresh(self):
        from fakes import build_tree
        return build_tree(composer_text=self.composer_text)
    def invalidate(self):
        self.invalidations+=1
    def resolve(self,name):
        if name=="message_input":
            return Mock()
        if name=="send_button":
            obj=Mock()
            obj.enabled.return_value=False
            return obj
        raise AssertionError(name)
    def unique_conversation(self,name):
        return Mock(states={"selected"})
class FakeS:
    def __init__(self):
        self.resolver=FakeResolver()
    def selected_conversation_name(self):
        return "FixtureRecipient"

class Safety(unittest.TestCase):
    def test_empty_requires_zero_and_button_disabled(self):
        self.assertTrue(m.empty_proven(FakeB(0),FakeS()))
        self.assertFalse(m.empty_proven(FakeB(1),FakeS()))
    def test_empty_rejects_send_enabled(self):
        s=FakeS()
        s.resolver.composer_text="draft-in-fake-only"
        self.assertFalse(m.empty_proven(FakeB(0),s))
    def test_clear_single_pair_only(self):
        with patch.object(m,"keyboard") as key:
            self.assertTrue(m.cleanup_once(FakeB(0),FakeS()))
            self.assertEqual([c.args[0] for c in key.call_args_list],["ctrl+a","BackSpace"])
    def test_clear_mismatch_does_not_prove_empty(self):
        with patch.object(m,"keyboard"):
            self.assertFalse(m.cleanup_once(FakeB(4),FakeS()))
    def test_focus_mismatch_fail_closed(self):
        s=FakeS()
        s.selected_conversation_name=lambda: "other"
        with self.assertRaises(UIBlocked):
            m.editor_focus(FakeB(0),s)
    def test_preflight_requires_independent_zero_unread(self):
        with patch.object(m.sys,"argv",["bench"]):
            with self.assertRaises(UIBlocked):
                m.preflight(FakeB(0),FakeS())
    def test_preflight_accepts_proven_selected_clean(self):
        with patch.object(m.sys,"argv",["bench","--unread-zero-verified"]):
            m.preflight(FakeB(0),FakeS())
    def test_clipboard_probe_contains_no_gui_actions(self):
        import inspect
        source = inspect.getsource(m.clipboard_preflight)
        self.assertNotIn("AtspiBackend", source)
        self.assertNotIn("keyboard(", source)

    def test_xclip_input_owner_is_nonblocking_for_nonempty_text(self):
        owner = Mock()
        owner.stdin = Mock()
        with patch.object(m, "shutil_which", return_value="/usr/bin/xclip"), \
             patch.object(m.subprocess, "Popen", return_value=owner) as popen, \
             patch.object(m.subprocess, "run") as run:
            m.clipboard_set(b"wx-test-marker")
        popen.assert_called_once()
        args, kwargs = popen.call_args
        self.assertEqual(args[0], ("xclip", "-selection", "clipboard", "-i"))
        self.assertEqual(kwargs["stdin"], m.subprocess.PIPE)
        self.assertEqual(kwargs["stdout"], m.subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], m.subprocess.DEVNULL)
        owner.stdin.write.assert_called_once_with(b"wx-test-marker")
        owner.stdin.close.assert_called_once()
        owner.wait.assert_not_called()
        owner.kill.assert_not_called()
        owner.communicate.assert_not_called()
        run.assert_not_called()

    def test_xclip_input_owner_is_nonblocking_for_empty_restore(self):
        owner = Mock()
        owner.stdin = Mock()
        with patch.object(m, "shutil_which", return_value="/usr/bin/xclip"), \
             patch.object(m.subprocess, "Popen", return_value=owner):
            m.clipboard_set(b"")
        owner.stdin.write.assert_called_once_with(b"")
        owner.stdin.close.assert_called_once()
        owner.wait.assert_not_called()
        owner.kill.assert_not_called()

    def test_disabled_send_is_visible_without_enabled_resolver(self):
        s=FakeS()
        with patch.object(s.resolver, "resolve", side_effect=AssertionError("must not resolve disabled Send")):
            self.assertFalse(m.send_enabled(s))

    def test_enabled_send_reads_true_from_ui_state(self):
        s=FakeS()
        s.resolver.composer_text="fake populated draft"
        self.assertTrue(m.send_enabled(s))

    def test_report_missing_target_contains_only_safe_booleans(self):
        import io
        from fakes import FakeBackend, build_tree
        stream=io.StringIO()
        b=FakeBackend(build_tree(selected="FixtureRecipient"))
        with patch.object(m.sys, "stdout", stream):
            m.report_missing_target("message_input", b)
        log=stream.getvalue()
        self.assertIn("target_id=message_input", log)
        self.assertIn("selected_expected=True", log)
        self.assertIn("composer_toolbar_visible=True", log)
        self.assertIn("send_button_visible=True", log)
        self.assertIn("send_button_enabled=False", log)
        self.assertNotIn("FixtureRecipient", log)
        self.assertNotIn("draft-", log)

    def test_instrument_prints_exact_target_for_every_missing_resolution(self):
        import io
        from fakes import FakeBackend, build_tree
        b=FakeBackend(build_tree())
        s=FakeS()
        s.resolver.resolve=Mock(side_effect=UIBlocked("TARGET_NOT_FOUND"))
        m.instrument_target_failures(s,b)
        stream=io.StringIO()
        with patch.object(m.sys,"stdout",stream):
            with self.assertRaises(UIBlocked):
                s.resolver.resolve("composer_toolbar")
            with self.assertRaises(UIBlocked):
                s.resolver.resolve("message_input")
        log=stream.getvalue()
        self.assertEqual(log.count("BENCH_TARGET_NOT_FOUND"),2)
        self.assertIn("target_id=composer_toolbar",log)
        self.assertIn("target_id=message_input",log)
        self.assertNotIn("FixtureRecipient",log)

    def test_selected_row_is_never_clicked(self):
        s=FakeS()
        ui=Mock()
        mode,steps=m.ensure_selected_once(s,FakeB(0),ui,zero_unread_verified=True)
        self.assertEqual((mode,steps),("already_selected",0))
        ui.open_read_safe_row.assert_not_called()

    def test_unselected_zero_unread_clicks_once_verified(self):
        s=FakeS()
        selected={"value":None}
        s.selected_conversation_name=lambda: selected["value"]
        s.resolver.unique_conversation=lambda name:Mock(states=frozenset())
        ui=Mock()
        def open_once(row,*,zero_unread_verified,dry_run):
            self.assertTrue(zero_unread_verified)
            self.assertFalse(dry_run)
            selected["value"]="FixtureRecipient"
            return Mock(state="ACKNOWLEDGED",steps=1)
        ui.open_read_safe_row.side_effect=open_once
        mode,steps=m.ensure_selected_once(s,FakeB(0),ui,zero_unread_verified=True)
        self.assertEqual((mode,steps),("opened_once",1))
        ui.open_read_safe_row.assert_called_once()
        self.assertEqual(s.resolver.invalidations,1)

    def test_unselected_without_unread_zero_never_clicks(self):
        s=FakeS()
        s.selected_conversation_name=lambda:None
        s.resolver.unique_conversation=lambda name:Mock(states=frozenset())
        ui=Mock()
        with self.assertRaises(UIBlocked) as caught:
            m.ensure_selected_once(s,FakeB(0),ui,zero_unread_verified=False)
        self.assertEqual(caught.exception.code,"BENCH_UNSELECTED_TARGET_NEEDS_UNREAD_ZERO_PROOF")
        ui.open_read_safe_row.assert_not_called()

    def test_other_selected_conversation_denied_without_click(self):
        s=FakeS()
        s.selected_conversation_name=lambda:"Other"
        s.resolver.unique_conversation=lambda name:Mock(states=frozenset())
        ui=Mock()
        with self.assertRaises(UIBlocked) as caught:
            m.ensure_selected_once(s,FakeB(0),ui,zero_unread_verified=True)
        self.assertEqual(caught.exception.code,"OTHER_CONVERSATION_SELECTED")
        ui.open_read_safe_row.assert_not_called()

    def test_unselected_open_requires_one_step_ack(self):
        s=FakeS()
        s.selected_conversation_name=lambda:None
        s.resolver.unique_conversation=lambda name:Mock(states=frozenset())
        ui=Mock()
        ui.open_read_safe_row.return_value=Mock(state="ACKNOWLEDGED",steps=0)
        with self.assertRaises(UIBlocked) as caught:
            m.ensure_selected_once(s,FakeB(0),ui,zero_unread_verified=True)
        self.assertEqual(caught.exception.code,"BENCH_ONE_CLICK_OPEN_UNVERIFIED")

    def test_readonly_diagnostic_has_no_input_actions(self):
        import inspect
        src=inspect.getsource(m.inspect_targets_readonly)
        self.assertIn("target_id=",src)
        self.assertNotIn("keyboard(",src)
        self.assertNotIn("clipboard_set(",src)
        self.assertNotIn("open_read_safe_row(",src)
        self.assertNotIn("activate(",src)

    def test_no_send_or_return_in_draft_path(self):
        import inspect
        source=inspect.getsource(m.main)+inspect.getsource(m._draft_once)
        self.assertNotIn('keyboard("Return")',source)
        self.assertNotIn('keyboard("Enter")',source)
        self.assertNotIn('keyboard("send")',source)
        self.assertNotIn(".activate(",source)

    def test_poison_is_verified_before_copy(self):
        import inspect
        src=inspect.getsource(m._draft_once)
        self.assertLess(src.index("clipboard_set(poison)"),
                        src.index("if not exact_utf8_sha_match(clipboard_get(),poison):"))
        self.assertLess(src.index("if not exact_utf8_sha_match(clipboard_get(),poison):"),
                        src.index('keyboard("ctrl+a")'))

    def test_disposable_clipboard_clear_requires_zero_readback(self):
        with patch.object(m,"clipboard_set") as setter, \
             patch.object(m,"clipboard_get",return_value=b""):
            self.assertTrue(m.clipboard_clear())
            setter.assert_called_once_with(b"")
        with patch.object(m,"clipboard_set"), \
             patch.object(m,"clipboard_get",return_value=b"nonempty"):
            self.assertFalse(m.clipboard_clear())

    def test_disposable_clipboard_clear_fails_closed_on_error(self):
        with patch.object(m,"clipboard_set",side_effect=UIBlocked("FAILED")):
            self.assertFalse(m.clipboard_clear())

    def test_clipboard_preflight_clears_twice_and_hash_verifies(self):
        import io
        state={"content":b"private-before-but-disposable"}
        values=[]
        def put(data):
            values.append(data)
            state["content"]=data
        with patch.object(m,"clipboard_set",side_effect=put), \
             patch.object(m,"clipboard_get",side_effect=lambda:state["content"]), \
             patch.object(m.sys,"stdout",io.StringIO()) as output:
            self.assertEqual(m.clipboard_preflight(),0)
        self.assertEqual(state["content"],b"")
        self.assertEqual(len(values),3)
        self.assertEqual(values[0],b"")
        self.assertEqual(values[-1],b"")
        self.assertIn("matched=True cleared=True",output.getvalue())
        self.assertNotIn("private-before",output.getvalue())

    def test_clipboard_preflight_mismatch_returns_four_and_clears(self):
        import io
        read_state={"value":b""}
        def put(data):
            read_state["value"]=b"bogus" if data else b""
        with patch.object(m,"clipboard_set",side_effect=put), \
             patch.object(m,"clipboard_get",side_effect=lambda:read_state["value"]), \
             patch.object(m.sys,"stdout",io.StringIO()) as output:
            self.assertEqual(m.clipboard_preflight(),4)
        self.assertEqual(read_state["value"],b"")
        self.assertIn("matched=False cleared=True",output.getvalue())

    def test_x11_owner_watch_bounded_event(self):
        watch=m.ClipboardOwnerWatch.__new__(m.ClipboardOwnerWatch)
        watch.x=Mock()
        watch.display=1
        watch.atom=2
        watch.fd=3
        watch.before=101
        watch.x.XGetSelectionOwner.side_effect=[101,202]
        watch.x.XPending.return_value=1
        self.assertTrue(watch.changed_to_new_owner(1.0))
        watch.x.XNextEvent.assert_called_once()

    def test_x11_owner_watch_timeout_failclosed(self):
        watch=m.ClipboardOwnerWatch.__new__(m.ClipboardOwnerWatch)
        watch.x=Mock()
        watch.display=1
        watch.atom=2
        watch.fd=3
        watch.before=101
        watch.x.XGetSelectionOwner.return_value=101
        watch.x.XPending.return_value=0
        with patch.object(m.select,"select",return_value=([],[],[])):
            self.assertFalse(watch.changed_to_new_owner(0.01))

    def test_copy_waits_for_owner_change_before_utf8_readback(self):
        actions=[]
        owner=Mock()
        owner.changed_to_new_owner.return_value=True
        def on_copy():
            actions.append("copy")
        def on_wait(timeout_seconds):
            actions.append("wait")
            return True
        owner.changed_to_new_owner.side_effect=on_wait
        with patch.object(m,"ClipboardOwnerWatch",return_value=owner) as ctor, \
             patch.object(m,"clipboard_targets_utf8",return_value=True) as targets, \
             patch.object(m,"clipboard_get",return_value=b"ascii-marker") as read:
            self.assertTrue(m.verify_copy_after_owner_event(b"ascii-marker",on_copy))
        self.assertEqual(actions,["copy","wait"])
        ctor.assert_called_once()
        targets.assert_called_once()
        read.assert_called_once()
        owner.close.assert_called_once()

    def test_no_owner_change_must_not_read_targets_or_clipboard(self):
        owner=Mock()
        owner.changed_to_new_owner.return_value=False
        with patch.object(m,"ClipboardOwnerWatch",return_value=owner), \
             patch.object(m,"clipboard_targets_utf8") as targets, \
             patch.object(m,"clipboard_get") as reader:
            with self.assertRaises(UIBlocked) as err:
                m.verify_copy_after_owner_event(b"test",lambda:None)
        self.assertEqual(err.exception.code,"X11_CLIPBOARD_OWNER_UNCHANGED")
        targets.assert_not_called()
        reader.assert_not_called()
        owner.close.assert_called_once()

    def test_utf8_targets_negotiated_explicitly(self):
        with patch.object(m,"command",return_value=b"TARGETS\nUTF8_STRING\nTEXT\n") as cmd:
            self.assertTrue(m.clipboard_targets_utf8())
        self.assertEqual(cmd.call_args.args,("xclip","-selection","clipboard","-o","-t","TARGETS"))
        with patch.object(m,"command",return_value=b"TARGETS\nSTRING\n"):
            self.assertFalse(m.clipboard_targets_utf8())

    def test_sha_length_comparison_only(self):
        self.assertTrue(m.exact_utf8_sha_match(b"ABC",b"ABC"))
        self.assertFalse(m.exact_utf8_sha_match(b"ABC",b"AB"))
        self.assertFalse(m.exact_utf8_sha_match(b"ABC",b"ABD"))
        self.assertTrue(m.exact_utf8_sha_match("سلام🙂".encode(), "سلام🙂".encode()))

    def test_pure_preflight_six_cases(self):
        m.verify_benchmark_preflight("FixtureRecipient",True,False)
        m.verify_benchmark_preflight(None,False,True)
        cases=[
            ("BENCH_UNSELECTED_TARGET_NEEDS_UNREAD_ZERO_PROOF",None,False,False),
            ("BENCH_OTHER_CONVERSATION_SELECTED","Other",False,True),
            ("BENCH_SELECTION_STATE_INCONSISTENT",None,True,True),
            ("BENCH_SELECTION_STATE_INCONSISTENT","FixtureRecipient",False,True),
        ]
        for code,sel,row,zero in cases:
            with self.assertRaises(UIBlocked) as err:
                m.verify_benchmark_preflight(sel,row,zero)
            self.assertEqual(err.exception.code,code)

    def test_ascii_before_persian_and_fails_closed(self):
        b=Mock()
        session=Mock()
        with patch.dict(m.os.environ,{"DISPLAY":":97}), \
             patch.object(m,"shutil_which",return_value="/usr/bin/test"), \
             patch.object(m,"AtspiBackend",return_value=b), \
             patch.object(m,"Session",return_value=session), \
             patch.object(m,"UiPrimitives"), \
             patch.object(m,"instrument_target_failures"), \
             patch.object(m,"ensure_selected_once",return_value=("already_selected",0)), \
             patch.object(m,"preflight"), \
             patch.object(m,"_draft_once",return_value=0) as draft:
            self.assertEqual(m.main(),0)
        self.assertEqual(draft.call_count,2)
        self.assertEqual(draft.call_args_list[0].args[3],"ASCII")
        self.assertTrue(draft.call_args_list[0].args[2].isascii())
        self.assertEqual(draft.call_args_list[1].args[3],"PERSIAN_EMOJI")
        self.assertIn("سلام".encode("utf-8"),draft.call_args_list[1].args[2])
        self.assertIn("🙂".encode("utf-8"),draft.call_args_list[1].args[2])

    def test_ascii_failure_never_attempts_persian(self):
        with patch.dict(m.os.environ,{"DISPLAY":":97}), \
             patch.object(m,"shutil_which",return_value="/usr/bin/test"), \
             patch.object(m,"AtspiBackend"), \
             patch.object(m,"Session"), \
             patch.object(m,"UiPrimitives"), \
             patch.object(m,"instrument_target_failures"), \
             patch.object(m,"ensure_selected_once",return_value=("already_selected",0)), \
             patch.object(m,"preflight"), \
             patch.object(m,"_draft_once",return_value=4) as trial:
            self.assertEqual(m.main(),4)
        self.assertEqual(trial.call_count,1)
        self.assertEqual(trial.call_args.args[3],"ASCII")

    def test_cleanup_clears_and_fails_closed_on_ambiguous_draft(self):
        import io
        output=io.StringIO()
        state={"value":b""}
        def put(data):
            state["value"]=data
        with patch.object(m,"clipboard_set",side_effect=put), \
             patch.object(m,"clipboard_get",side_effect=lambda:state["value"]), \
             patch.object(m,"editor_focus"), \
             patch.object(m,"keyboard",side_effect=UIBlocked("DID_NOT_PASTE")), \
             patch.object(m,"cleanup_once",return_value=True) as cleanup, \
             patch.object(m.sys,"stdout",output):
            rc=m._draft_once(Mock(),Mock(),b"test","ASCII")
        self.assertEqual(rc,4)
        self.assertEqual(state["value"],b"")
        cleanup.assert_called_once()
        self.assertIn("clipboard_cleared=True",output.getvalue())
        self.assertNotIn("test",output.getvalue())

    def test_cleanup_failure_is_in_doubt_even_if_clipboard_clear(self):
        import io
        with patch.object(m,"clipboard_clear",return_value=True), \
             patch.object(m,"editor_focus"), \
             patch.object(m,"clipboard_set"), \
             patch.object(m,"clipboard_get",return_value=b"mismatch"), \
             patch.object(m,"cleanup_once",return_value=False), \
             patch.object(m.sys,"stdout",io.StringIO()) as output:
            rc=m._draft_once(Mock(),Mock(),b"test","ASCII")
        self.assertEqual(rc,3)
        self.assertIn("empty_two_conditions=False",output.getvalue())
        self.assertIn("BENCH_IN_DOUBT",output.getvalue())

    def test_clipboard_not_cleared_is_in_doubt(self):
        import io
        with patch.object(m,"clipboard_clear",side_effect=[True,False]), \
             patch.object(m,"editor_focus"), \
             patch.object(m,"clipboard_set"), \
             patch.object(m,"clipboard_get",return_value=b"mismatch"), \
             patch.object(m,"cleanup_once",return_value=True), \
             patch.object(m.sys,"stdout",io.StringIO()) as output:
            rc=m._draft_once(Mock(),Mock(),b"test","ASCII")
        self.assertEqual(rc,3)
        self.assertIn("clipboard_cleared=False",output.getvalue())

if __name__=="__main__":
    unittest.main()
