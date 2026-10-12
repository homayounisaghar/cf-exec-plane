"""Offline-only Gate click accuracy + common pointer regressions. No X input."""
import contextlib
import io
import os
import unittest
from unittest.mock import Mock,patch
os.environ["WX_GATE_F_TARGET"]="FixtureRecipient"

from engine import Node,Rect,Snapshot,UIBlocked
import pointer_mapping as pm
import gate_click_accuracy as g
from ui_primitives import UiPrimitives

ST=frozenset(("visible","showing","enabled","sensitive"))

def button(path=(0,1),name="Chat Info",rect=Rect(1086,202,28,28)):
    return Node(path,"button",name,ST,rect)

def tree(*nodes):
    return Snapshot("a",880,640,tuple(nodes))

class PointerShared(unittest.TestCase):
    def test_exact_hit_plan(self):
        n=button()
        b=Mock(hit_test=Mock(return_value=n))
        self.assertEqual(pm.logical_hit_plan(b,n),("HIT_TEST_CLICK",1100,216))
        b.hit_test.assert_called_once_with(1100,216)

    def test_child_hit_is_only_allowed_when_explicit(self):
        n=button()
        child=Node((0,1,0),"button","",ST,Rect(1090,206,20,20))
        b=Mock(hit_test=Mock(return_value=child))
        with self.assertRaises(UIBlocked):
            pm.logical_hit_plan(b,n)
        self.assertEqual(pm.logical_hit_plan(b,n,allow_descendant=True)[1:],(1100,216))

    def test_sibling_hit_never_plans(self):
        n=button()
        b=Mock(hit_test=Mock(return_value=button(path=(0,2))))
        with self.assertRaises(UIBlocked) as e: pm.logical_hit_plan(b,n,allow_descendant=True)
        self.assertEqual(e.exception.code,"POINTER_TARGET_HIT_TEST_FAILED")

    def test_non_visible_or_disabled_never_plans(self):
        for st in (frozenset(("visible",)),frozenset(("visible","showing"))):
            n=Node((0,1),"button","Chat Info",st,Rect(1,1,28,28))
            b=Mock()
            with self.assertRaises(UIBlocked): pm.logical_hit_plan(b,n)
            b.hit_test.assert_not_called()

    def test_hover_shared_uses_frame_and_exact_logical_hit(self):
        root=Node((0,),"frame","WeChat",ST,Rect(251,160,880,640))
        n=button()
        b=Mock()
        b.snapshot.return_value=tree(root,n)
        b.hit_test.return_value=n
        with patch.object(pm,"_verify_pointer_mapping",return_value=("HIT_TEST_CLICK",1145,225)) as mapping:
            self.assertEqual(pm.hover_target(b,n),("HIT_TEST_CLICK",1145,225))
        mapping.assert_called_once()
        self.assertEqual(mapping.call_args.args[0],("HIT_TEST_CLICK",1100,216))
        self.assertEqual(mapping.call_args.args[1],root.rect)

    def test_hover_never_moves_if_hit_wrong(self):
        root=Node((0,),"frame","WeChat",ST,Rect(251,160,880,640))
        n=button()
        b=Mock()
        b.snapshot.return_value=tree(root,n)
        b.hit_test.return_value=None
        with patch.object(pm,"_verify_pointer_mapping") as map_:
            with self.assertRaises(UIBlocked): pm.hover_target(b,n)
        map_.assert_not_called()

    def test_click_once_one_call_only(self):
        result=Mock(returncode=0)
        with patch.object(pm.subprocess,"run",return_value=result) as run,contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(pm.click_once(("HIT_TEST_CLICK",1126,800)))
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0],("xdotool","mousemove","1126","800","click","1"))

    def test_invalid_physical_plan_blocks_without_click(self):
        with patch.object(pm.subprocess,"run") as run:
            with self.assertRaises(UIBlocked):
                pm.click_once(("AT_SPI_ACTION",0,0))
        run.assert_not_called()

class ControlResolution(unittest.TestCase):
    @staticmethod
    def controls():
        toolbar=Node((0,1),"tool bar","",ST,Rect(560,747,562,44))
        sticker=button((0,1,0),"",Rect(568,755,28,28))
        unknown=button((0,1,1),"",Rect(604,755,28,28))
        file=button((0,1,2),"Send File",Rect(640,755,28,28))
        chat=button((0,2),"Chat Info",Rect(1086,202,28,28))
        return tree(toolbar,sticker,unknown,file,chat)

    def test_three_controls_unique_and_ordered(self):
        s=self.controls()
        self.assertEqual(g._target(s,"chat_info").name,"Chat Info")
        self.assertEqual(g._target(s,"sticker").rect.x,568)
        self.assertEqual(g._target(s,"file_chooser").name,"Send File")

    def test_duplicate_chat_info_blocks(self):
        s=self.controls()
        s=Snapshot(s.revision,s.width,s.height,s.nodes+(button((0,3)),))
        with self.assertRaises(UIBlocked) as e: g._target(s,"chat_info")
        self.assertEqual(e.exception.code,"CLICK_CONTROL_NOT_UNIQUE")

    def test_sticker_requires_named_file_anchor(self):
        s=self.controls()
        s=Snapshot(s.revision,s.width,s.height,tuple(n for n in s.nodes if n.name!="Send File"))
        with self.assertRaises(UIBlocked): g._target(s,"sticker")

    def test_sticker_hover_tooltip_required(self):
        tooltip=Node((0,4),"label","Sticker",ST,Rect(580,700,80,28))
        self.assertTrue(g._hint_visible(tree(tooltip)))
        self.assertFalse(g._hint_visible(tree(button(name="Unrelated"))))

    def test_hover_tooltip_not_counted_as_popup(self):
        b=self.controls()
        label=Node((0,9),"label","Sticker",ST,Rect(580,700,80,28))
        a=Snapshot("b",b.width,b.height,b.nodes+(label,))
        self.assertFalse(g._changed(b,a))

    def test_new_panel_detected(self):
        b=self.controls()
        extras=tuple(button((0,8,j),"",Rect(800+j*30,400,25,25)) for j in range(4))
        a=Snapshot("b",b.width,b.height,b.nodes+extras)
        self.assertTrue(g._changed(b,a))

class ClickSequence(unittest.TestCase):
    def test_unread_flag_absent_prevents_all_clicks(self):
        with patch.dict(os.environ,{"WX_GATE_CLICK_ACCURACY":"0"},clear=False),patch.object(g,"AtspiBackend") as backend:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(g.main(),2)
        backend.assert_not_called()

    def test_missing_mouse_mapping_means_zero_clicks(self):
        n=button()
        b=Mock(snapshot=Mock(return_value=tree(n)))
        with patch.object(g,"_ui",return_value=b"digest"),patch.object(g,"UiPrimitives"),patch.object(g,"_target",return_value=n),patch.object(g,"hover_target",side_effect=UIBlocked("POINTER_MAPPING_UNVERIFIED")),patch.object(g,"click_once") as click:
            with self.assertRaises(UIBlocked),contextlib.redirect_stdout(io.StringIO()):
                g._run_one(b,"chat_info",b"digest")
        click.assert_not_called()

    def test_one_open_click_and_one_escape_close(self):
        n=button()
        b=Mock(snapshot=Mock(return_value=tree(n)))
        with patch.object(g,"_ui",return_value=b"digest"),patch.object(g,"UiPrimitives"),patch.object(g,"_target",return_value=n),patch.object(g,"hover_target",return_value=("HIT_TEST_CLICK",1126,800)),patch.object(g,"_await",return_value=(True,tree(n))),patch.object(g,"_escape") as esc,patch.object(g,"_closed",return_value=True),patch.object(g,"click_once",return_value=True) as click,contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(g._run_one(b,"chat_info",b"digest"))
        click.assert_called_once_with(("HIT_TEST_CLICK",1126,800))
        esc.assert_called_once()

    def test_false_appearance_stops_after_cleanup(self):
        n=button()
        b=Mock(snapshot=Mock(return_value=tree(n)))
        with patch.object(g,"_ui",return_value=b"digest"),patch.object(g,"UiPrimitives"),patch.object(g,"_target",return_value=n),patch.object(g,"hover_target",return_value=("HIT_TEST_CLICK",1126,800)),patch.object(g,"_await",return_value=(False,tree(n))),patch.object(g,"_escape") as esc,patch.object(g,"_closed",return_value=True),patch.object(g,"click_once",return_value=True) as click,contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(UIBlocked) as e: g._run_one(b,"file_chooser",b"digest")
        self.assertEqual(e.exception.code,"EXPECTED_UI_NOT_OBSERVED_STOP")
        click.assert_called_once()
        esc.assert_called_once()

    def test_not_closed_stops_before_next_target(self):
        n=button()
        b=Mock(snapshot=Mock(return_value=tree(n)))
        with patch.object(g,"_ui",return_value=b"digest"),patch.object(g,"UiPrimitives"),patch.object(g,"_target",return_value=n),patch.object(g,"hover_target",return_value=("HIT_TEST_CLICK",1126,800)),patch.object(g,"_await",return_value=(True,tree(n))),patch.object(g,"_escape"),patch.object(g,"_closed",return_value=False),patch.object(g,"click_once",return_value=True),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(UIBlocked) as e: g._run_one(b,"file_chooser",b"digest")
        self.assertEqual(e.exception.code,"UI_NOT_CLOSED_STOP")

    def test_no_enter_send_or_file_choice_in_script(self):
        import inspect
        s=inspect.getsource(g)
        for forbidden in ("do_action(", "backend.activate(", "Return", "KP_Enter",
                          "Send_FILE", "choose_file", "file_select(", "WX_GATE_H_SEND_ONCE"):
            self.assertNotIn(forbidden,s)

if __name__=="__main__":
    unittest.main()
