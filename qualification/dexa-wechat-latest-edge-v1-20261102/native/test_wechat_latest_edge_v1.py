import unittest
from copy import deepcopy
from wechat_latest_edge_v1 import verify_latest_edge


def snapshot(preview="Yoyo, just confirming the next step in our project.",
             last="Yoyo, just confirming the next step in our project.",
             bottom=659,selected=True):
    rows=[
      {"role":"list","name":"Messages","states":["showing","visible"],
       "path":"/0/1/2","depth":5,"bounds":{"x":552,"y":241,"width":578,"height":418}},
      {"role":"list item","name":"Yesterday 07:20","states":["showing","visible"],
       "path":"/0/1/2/0","depth":6,"bounds":{"x":552,"y":291,"width":578,"height":41}},
      {"role":"list item","name":"Older message from WeChat.","states":["showing","visible"],
       "path":"/0/1/2/1","depth":6,"bounds":{"x":552,"y":332,"width":578,"height":111}},
      {"role":"list item","name":last,"states":["showing","visible"],
       "path":"/0/1/2/2","depth":6,"bounds":{"x":552,"y":484,"width":578,"height":bottom-484}},
    ]
    projection={"messages":[{"body":"Older message from WeChat."},{"body":last}],
                "at_latest_edge_verified":False}
    return rows,projection,[preview] if selected else []


class EdgeTests(unittest.TestCase):
    def test_at_bottom_exact_live_shape(self):
        r,p,v=snapshot()
        saved=deepcopy((r,p,v))
        o=verify_latest_edge(r,p,v)
        self.assertTrue(o["verified"],o)
        self.assertEqual((r,p,v),saved)

    def test_truncated_preview_and_whitespace(self):
        text="Yoyo，想跟你简单确认一下，目前是否还有什么需要我这边提供或确认的？"
        r,p,v=snapshot(preview=text[:32]+"…",last=text[:29]+"\n\n"+text[29:])
        self.assertTrue(verify_latest_edge(r,p,v)["verified"])

    def test_scrolled_up_even_matching_text_fails(self):
        r,p,v=snapshot(bottom=620)
        self.assertEqual(verify_latest_edge(r,p,v)["reason"],
                         "VISIBLE_LAST_ROW_NOT_AT_VIEWPORT_END")

    def test_old_visible_message_with_new_preview_fails(self):
        r,p,v=snapshot(preview="Newer message that is not on the screen.")
        self.assertEqual(verify_latest_edge(r,p,v)["reason"],
                         "LAST_VISIBLE_MESSAGE_DIFFERS_FROM_CHAT_PREVIEW")

    def test_selected_chat_not_unique(self):
        r,p,v=snapshot()
        self.assertFalse(verify_latest_edge(r,p,[v[0],v[0]])["verified"])

    def test_no_message_body_no_false_absence(self):
        r,p,v=snapshot()
        p["messages"]=[]
        self.assertEqual(verify_latest_edge(r,p,v)["reason"],"NO_VISIBLE_TEXT_MESSAGE")

    def test_preview_too_short_is_not_proof(self):
        r,p,v=snapshot(preview="OK")
        self.assertFalse(verify_latest_edge(r,p,v)["verified"])

    def test_last_accessible_row_mismatch_is_not_proof(self):
        r,p,v=snapshot()
        r[-1]["name"]="A different on-screen message; must not be substituted."
        self.assertFalse(verify_latest_edge(r,p,v)["verified"])

if __name__=="__main__":
    unittest.main()
