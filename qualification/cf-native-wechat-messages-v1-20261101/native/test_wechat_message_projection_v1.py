import unittest
from wechat_message_projection_v1 import project_message_rows

def r(role,name,path,depth,show=True,x=560,y=60,w=850,h=30):
    return {"role":role,"name":name,"path":path,"depth":depth,
            "states":["showing","visible"] if show else [],
            "bounds":{"x":x,"y":y,"width":w,"height":h}}

class BoundedMessageList(unittest.TestCase):
    def test_real_world_style_three_message_rows_and_separator(self):
        rows=[
         r("list","Messages","/0/1/3",3,y=100,w=870),
         r("list item","Video 0:23","/0/1/3/2",4,x=1100,y=400,w=215),
         r("list item","Today 12:06","/0/1/3/0",4,y=150),
         r("list item","Z-YU\n好的没问题","/0/1/3/1",4,x=575,y=220,w=260),
         r("list","Chats","/0/1/0",3),
         r("list item","Unrelated","/0/1/0/0",4,x=200,y=120)
        ]
        d=project_message_rows(rows,10)
        self.assertEqual(d["returned"],2)
        self.assertEqual(d["messages"][0]["direction"],"incoming")
        self.assertEqual(d["messages"][1]["direction"],"outgoing")
        self.assertEqual(d["messages"][0]["body"],"Z-YU\n好的没问题")
        self.assertEqual(d["messages"][1]["after_separator"],"Today 12:06")
        self.assertIsNone(d["messages"][0]["sender"])
        self.assertFalse(d["complete"])
        self.assertFalse(d["at_latest_edge_verified"])
    def test_limit_is_visible_tail_only_no_global_claims(self):
        rows=[r("list","Messages","/a",1)]
        for i in range(5):
            rows.append(r("list item",f"text{i}",f"/a/{i}",2,y=100+60*i))
        x=project_message_rows(rows,2)
        self.assertEqual([p["body"] for p in x["messages"]],["text3","text4"])
        self.assertTrue(x["truncated_to_limit"])
        self.assertEqual(x["visible_message_count"],5)
    def test_no_rows_is_explicitly_incomplete_not_an_empty_inbox(self):
        x=project_message_rows([r("list","Messages","/a",1)],3)
        self.assertEqual(x["observation_state"],"NO_VISIBLE_MESSAGE_BODIES")
        self.assertFalse(x["complete"])
        self.assertEqual(x["messages"],[])
    def test_fail_closed_on_missing_or_ambiguous_message_list(self):
        with self.assertRaisesRegex(ValueError,"NOT_UNIQUE"):
            project_message_rows([r("list","Chats","/a",1)])
        with self.assertRaisesRegex(ValueError,"NOT_UNIQUE"):
            project_message_rows([r("list","Messages","/a",1),r("list","Messages","/b",1)])
    def test_filter_out_offscreen_unrelated_nested_and_empty(self):
        rows=[r("list","Messages","/a",1),
            r("list item","hidden","/a/1",2,False),
            r("list item","nested","/a/2/0",3),
            r("list item","other","/b/0",2),
            r("list item","","/a/3",2),
            r("list item","only","/a/4",2)]
        self.assertEqual([x["body"] for x in project_message_rows(rows)["messages"]],["only"])
    def test_ambiguous_geometry_never_forges_direction(self):
        rows=[r("list","Messages","/a",1,x=550,w=870),
              r("list item","Hello","/a/0",2,x=553,w=865)]
        x=project_message_rows(rows)["messages"][0]
        self.assertEqual(x["direction"],"unknown")
        self.assertEqual(x["direction_evidence"],"row_spans_or_crosses_midline")
        self.assertIsNone(x["sender"])
    def test_time_only_row_not_message(self):
        rows=[r("list","Messages","/a",1),
              r("list item","08:24","/a/0",2),
              r("list item","Yesterday 03:11","/a/1",2,y=150),
              r("list item","Hi","/a/2",2,y=200)]
        x=project_message_rows(rows)
        self.assertEqual(x["returned"],1)
        self.assertEqual(x["messages"][0]["after_separator"],"Yesterday 03:11")
    def test_invalid_limits_and_missing_viewport_paths(self):
        for v in (0,51,True,"3"):
            with self.assertRaisesRegex(ValueError,"LIMIT"):
                project_message_rows([],v)
        with self.assertRaisesRegex(ValueError,"PATH"):
            project_message_rows([r("list","Messages","",1)],2)

if __name__=="__main__":
    unittest.main()
