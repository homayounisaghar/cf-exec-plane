"""Offline safety regression: ambiguous Qt text writes never double-type."""
from atspi_backend import AtspiBackend
from engine import Node, Rect, UIBlocked

states=frozenset(("editable","visible","showing","enabled","sensitive"))
node=Node((0,1,2),"text","",states,Rect(1,2,100,24))

class Editor:
    def __init__(self, result=True, throws=False):
        self.calls=0;self.result=result;self.throws=throws
    def set_text_contents(self, value):
        self.calls+=1
        if self.throws:raise RuntimeError("provider-ambiguous")
        return self.result

class Acc:
    def __init__(self, editor):
        self.editor=editor
    def get_editable_text_iface(self):
        return self.editor

def backend(editor, observed):
    b=AtspiBackend.__new__(AtspiBackend)
    b._find=lambda n:Acc(editor)
    b.editable_text=lambda n:observed
    b.focus=lambda n:(_ for _ in ()).throw(AssertionError("synthetic fallback forbidden"))
    b._key=lambda *args:(_ for _ in ()).throw(AssertionError("typing fallback forbidden"))
    return b

checks=0
def check(condition):
    global checks
    assert condition
    checks+=1
    print("[PASS] text safety",checks)

ed=Editor(True); check(backend(ed,None).replace_text(node,"draft")==False and ed.calls==1)
ed=Editor(False);check(backend(ed,None).replace_text(node,"draft")==False and ed.calls==1)
ed=Editor(True,True);check(backend(ed,None).replace_text(node,"draft")==False and ed.calls==1)
ed=Editor(True);check(backend(ed,"draft").replace_text(node,"draft")==True and ed.calls==1)
check(backend(None,None).replace_text(node,"draft")==False)
try:
    backend(Editor(),None).replace_text(Node((1,),"password text","",states),"secret")
except UIBlocked as e:
    check(e.code=="TEXT_TARGET_OR_LENGTH_INVALID")
else:
    raise AssertionError("password editing was not denied")
print("%d/%d passed"%(checks,checks))
