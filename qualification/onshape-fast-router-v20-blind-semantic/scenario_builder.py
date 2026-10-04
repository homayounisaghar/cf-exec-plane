from __future__ import annotations
import argparse, json, pathlib

STYLES=["spoken-fa","cad-shorthand-fa","code-mixed","polite-fa","context-fragment","mobile-light"]
ZERO={"ambiguous":False,"conditional":False,"multi_effect":False,"invalid_quantity":False,"negated_only":False}

def F(**kw):
    x=dict(ZERO); x.update(kw); return x
def DO(op,args=None): return {"route":"do","op":op,"args":args or {}}
def ASK(): return {"route":"ask","op":None,"args":{}}
def THINK(): return {"route":"think","op":None,"args":{}}
def amount(v,u="mm"): return f"{('%g'%v)} {u}"

def add(rows,fam,i,meaning,gold,ctx=None,safety="bounded_mutation",lits=None,flags=None,scope="apprentice",extra=None):
    rows.append({
      "scenario_id":f"v20_{fam}_{i:04d}","family":fam,"scope":scope,
      "semantic_description":meaning,"gold":gold,"context":ctx or {},
      "safety_class":safety,"expected_flags":flags or F(),
      "value_provenance":{"preserve_literals":lits or []},
      "realization_constraints":{"language":"Persian","style_bucket":STYLES[i%len(STYLES)],"preserve_literals":lits or [],**(extra or {})}
    })

def build():
    R=[]; vals=[0.35,0.55,0.8,1.05,1.3,1.6,1.9,2.25,2.7,3.4]
    colors=["red","blue","green","yellow","orange","purple","gray","black"]
    materials=["Steel","Titanium","ABS","Aluminum","Nylon","Copper","Brass","PEEK"]
    dirs=["left","right","up","down"]; opp={"left":"right","right":"left","up":"down","down":"up"}

    for i in range(200):
        d="left" if i%2==0 else "right"; add(R,"orbit_horizontal",i,f"Orbit the camera horizontally around the model toward {d}.",DO("view.move",{"action":"orbit","direction":d}),safety="reversible_view")
    for i in range(200):
        d="up" if i%2==0 else "down"; add(R,"orbit_vertical",i,f"Orbit the camera vertically around the model toward {d}.",DO("view.move",{"action":"orbit","direction":d}),safety="reversible_view")
    for i in range(200):
        d="clockwise" if i%2==0 else "counterclockwise"; add(R,"orbit_roll",i,f"Roll the camera view {d} around the viewing axis.",DO("view.move",{"action":"orbit","direction":d}),safety="reversible_view")
    for fam,axis in [("pan_horizontal",("left","right")),("pan_vertical",("up","down"))]:
        for i in range(200):
            d=axis[i%2]; add(R,fam,i,f"Pan the viewport toward {d} without orbiting.",DO("view.move",{"action":"pan","direction":d}),safety="reversible_view")
    for i in range(200):
        d="in" if i%2==0 else "out"; add(R,"zoom",i,f"Change camera zoom {d}.",DO("view.move",{"action":"zoom","direction":d}),safety="reversible_view")
    for i in range(200): add(R,"fit_all",i,"Fit the complete model geometry into the viewport, not only the selection.",DO("view.fit",{"action":"fit"}),safety="reversible_view")
    for i in range(200):
        n=1+i%3; add(R,"fit_selection",i,"Fit only the current selection into the viewport.",DO("view.fit",{"action":"fit_selection"}),{"selection_count":n,"selection_types":["edge"]*n},safety="reversible_view")
    for i in range(200): add(R,"top_view",i,"Set the standard Top view.",DO("view.standard",{"view":"top"}),safety="reversible_view")
    for i in range(200): add(R,"clear_selection",i,"Clear all current viewer selection.",DO("viewer.selection.clear",{}),{"selection_count":1+i%4},safety="reversible_view")
    for i in range(200): add(R,"inspect_selection",i,"Report current selected entities without changing them.",DO("viewer.inspect",{"mode":"selection"}),{"selection_count":i%4},safety="read_only")
    for i in range(200): add(R,"inspect_state",i,"Report current viewer and camera state without changing it.",DO("viewer.inspect",{"mode":"state"}),safety="read_only")
    for i in range(200): add(R,"inspect_collaboration",i,"Report collaborators currently present in the document session.",DO("viewer.inspect",{"mode":"collaboration"}),{"collaborator_count":2+i%3},safety="read_only")
    for i in range(200): add(R,"follow_pair",i,"With exactly two collaborators, follow the other collaborator's view.",DO("view.follow",{}),{"collaborator_count":2},safety="reversible_view")
    for i in range(200): add(R,"follow_three",i,"With three collaborators, follow collaborator number 2.",DO("view.follow",{"candidate_index":2}),{"collaborator_count":3},safety="reversible_view")

    for i in range(200):
        v=vals[i%10]; n=1+i%3; a=amount(v)
        add(R,"selected_fillet",i,f"Apply a fillet of {a} to current selected edges.",DO("feature.from_selection",{"feature_type":"fillet","amount":a}),{"selection_count":n,"selection_types":["edge"]*n},lits=[a])
    for i in range(200):
        v=vals[(i+3)%10]; a=amount(v)
        add(R,"selected_chamfer",i,f"Apply a chamfer of {a} to the current selected edge.",DO("feature.from_selection",{"feature_type":"chamfer","amount":a}),{"selection_count":1,"selection_types":["edge"]},lits=[a])
    for i in range(200):
        a=amount(vals[(i+1)%10]); add(R,"new_fillet",i,f"Create a new empty fillet feature of {a} with no selected edge.",DO("feature.add",{"feature_type":"fillet","amount":a}),{"selection_count":0},lits=[a])
    for i in range(200):
        a=amount(vals[(i+5)%10]); add(R,"new_chamfer",i,f"Create a new empty chamfer feature of {a} with no selected edge.",DO("feature.add",{"feature_type":"chamfer","amount":a}),{"selection_count":0},lits=[a])

    for i in range(200):
        f=f"Fillet {3+i%67}"; a=amount(0.4+(i%26)*0.2); add(R,"fillet_radius",i,f"Set radius of {f} to {a}.",DO("feature.parameter.set",{"feature_name":f,"parameter":"radius","amount":a}),lits=[f,a])
    for i in range(200):
        f=f"Extrude {3+i%67}"; a=amount(2+i%39); add(R,"extrude_depth",i,f"Set depth of {f} to {a}.",DO("feature.parameter.set",{"feature_name":f,"parameter":"depth","amount":a}),lits=[f,a])
    for i in range(200):
        f=f"Draft {3+i%67}"; a=amount(2+i%23,"deg"); add(R,"draft_angle",i,f"Set angle of {f} to {a}.",DO("feature.parameter.set",{"feature_name":f,"parameter":"angle","amount":a}),lits=[f,a])
    for i in range(200):
        f=f"Extrude {3+i%61}"; v=i%2==0; add(R,"flip_direction",i,f"Set flip direction of {f} to {str(v).lower()}.",DO("feature.parameter.set",{"feature_name":f,"parameter":"flip direction","value":v}),lits=[f])
    for i in range(200):
        f=f"Extrude {3+i%61}"; add(R,"suppress",i,f"Suppress existing feature {f}.",DO("feature.patch",{"feature_name":f,"suppressed":True}),lits=[f])
    for i in range(200):
        f=f"Extrude {3+i%61}"; add(R,"unsuppress",i,f"Unsuppress existing feature {f}.",DO("feature.patch",{"feature_name":f,"suppressed":False}),lits=[f])
    for i in range(200):
        f=f"Fillet {3+i%59}"; n=f"node alpha {i%73}"; add(R,"feature_rename",i,f"Rename {f} to exact literal '{n}'.",DO("feature.patch",{"feature_name":f,"new_name":n}),lits=[f,n])
    for i in range(200):
        f=f"Fillet {3+i%59}"; add(R,"feature_delete",i,f"Delete existing feature {f}.",DO("feature.delete",{"feature_name":f}),lits=[f])

    for i in range(200):
        p=f"Part {3+i%79}"; add(R,"part_hide",i,f"Hide {p} in viewport.",DO("part.visibility",{"part_name":p,"visible":False}),lits=[p])
    for i in range(200):
        p=f"Part {3+i%79}"; add(R,"part_show",i,f"Show {p} in viewport.",DO("part.visibility",{"part_name":p,"visible":True}),lits=[p])
    for i in range(200):
        p=f"Part {3+i%79}"; add(R,"part_delete",i,f"Delete part {p} from the model.",DO("feature.delete_part",{"part_name":p}),lits=[p])
    for i in range(200):
        p=f"Part {3+i%79}"; v=colors[i%8]; add(R,"part_color",i,f"Set appearance color of {p} to {v}.",DO("metadata.property.set",{"part_name":p,"property":"color","value":v}),lits=[p,v])
    for i in range(200):
        p=f"Part {3+i%79}"; v=materials[i%8]; add(R,"part_material",i,f"Set material of {p} to exact value '{v}'.",DO("metadata.property.set",{"part_name":p,"property":"material","value":v}),lits=[p,v])
    for i in range(200):
        p=f"Part {3+i%79}"; v=f"inspection orbit note {i%83}"; add(R,"part_description",i,f"Set description of {p} to exact literal '{v}'.",DO("metadata.property.set",{"part_name":p,"property":"description","value":v}),lits=[p,v])
    for i in range(200):
        p=f"Part {3+i%79}"; v=f"top material component {i%71}"; add(R,"part_rename",i,f"Rename part {p} to exact literal '{v}'.",DO("documented.updateWVEPMetadata",{"part_name":p,"property":"name","value":v}),lits=[p,v])

    for i in range(200):
        n=f"reference orbit plane {i%73}"; add(R,"plane_named",i,f"Create a reference plane named exact literal '{n}'.",DO("feature.add",{"feature_type":"plane","name":n}),lits=[n])
    for i in range(200): add(R,"plane_plain",i,"Create a new unnamed reference plane.",DO("feature.add",{"feature_type":"plane"}))
    for i in range(200):
        p=f"Part {3+i%79}"; c=2+i%7; d=3+i%17; ds=f"{d} mm"; add(R,"linear_pattern",i,f"Create a linear pattern of {p} with {c} copies spaced {ds}.",DO("feature.add",{"feature_type":"linearPattern","part_name":p,"copies":c,"distance":ds}),lits=[p,str(c),ds])
    for i in range(200):
        a=f"Extrude {3+i%53}"; b=f"Fillet {20+i%43}"; q="before" if i%2==0 else "after"; add(R,"feature_reorder",i,f"Move {a} so it is {q} {b} in feature tree.",DO("feature.reorder",{"source_feature":a,"target_feature":b,"placement":q}),lits=[a,b])
    for i in range(200):
        t=f"Extrude {4+i%57}"; before=i%2==0; g=DO("rollback.set",{"before_feature":t} if before else {"after_feature":t}); add(R,"rollback",i,f"Move rollback bar immediately {'before' if before else 'after'} {t}.",g,lits=[t])
    for i in range(200):
        n=f"workspace beta {i%79}"; add(R,"create_part_studio",i,f"Create a new Part Studio named exact literal '{n}'.",DO("documented.createPartStudio",{"new_name":n}),lits=[n])
    for i in range(200):
        n=f"selection archive {i%83}"; add(R,"rename_document",i,f"Rename current document to exact literal '{n}'.",DO("documented.updateDocumentAttributes",{"new_name":n}),lits=[n])

    for i in range(200):
        d=dirs[i%4]; ctx={"last_move":{"action":"orbit","direction":d,"intensity":0.35},"last_action":"view.move"}; add(R,"context_camera_continue",i,"Repeat the immediately previous camera movement in the same direction.",DO("view.move",{"action":"orbit","direction":d}),ctx,safety="reversible_view")
    for i in range(200):
        d=dirs[i%4]; ctx={"last_move":{"action":"orbit","direction":d,"intensity":0.35},"last_action":"view.move"}; add(R,"context_camera_reverse",i,"Move the camera opposite to the immediately previous camera movement.",DO("view.move",{"action":"orbit","direction":opp[d]}),ctx,safety="reversible_view")
    for i in range(200):
        cur=1.0+(i%12)*0.25; delta=0.25+((i//12)%4)*0.25; up=i%2==0; fin=cur+delta if up else max(0.25,cur-delta)
        ctx={"last_feature":"Fillet 9","feature_parameters":{"radius":amount(cur)}}; da=amount(delta)
        add(R,"context_relative",i,f"Change radius of context feature Fillet 9 by {da} {'up' if up else 'down'} from current {amount(cur)}, ending at {amount(fin)}.",DO("feature.parameter.set",{"feature_name":"Fillet 9","parameter":"radius","amount":amount(fin)}),ctx,lits=[da])

    for i in range(200):
        m=i%5
        if m==0: desc="Cancel hiding Part 8 and instead request Part 8 visible."; g=DO("part.visibility",{"part_name":"Part 8","visible":True}); ctx={}; fl=F(); lits=["Part 8"]; saf="bounded_mutation"
        elif m==1: desc="Cancel zoom-in and instead request zoom-out."; g=DO("view.move",{"action":"zoom","direction":"out"}); ctx={}; fl=F(); lits=[]; saf="reversible_view"
        elif m==2: desc="Cancel Top view and instead request clearing current selection."; g=DO("viewer.selection.clear",{}); ctx={"selection_count":2}; fl=F(); lits=[]; saf="reversible_view"
        elif m==3: desc="Only state that Fillet 7 must not be deleted; request no positive replacement action."; g=ASK(); ctx={}; fl=F(negated_only=True); lits=["Fillet 7"]; saf="clarification_required"
        else: desc="Cancel clearing selection and instead request a read-only report of selected entities."; g=DO("viewer.inspect",{"mode":"selection"}); ctx={"selection_count":2}; fl=F(); lits=[]; saf="read_only"
        add(R,"negation_correction",i,desc,g,ctx,saf,lits,fl,extra={"preserve_negation_structure":True})

    multi=["hide Part 6 and also switch to Top view","clear selection and also set Part 9 color blue","delete Fillet 8 and also suppress Extrude 11","zoom out and also pan right","fit current selection and also follow other collaborator"]
    for i in range(200): add(R,"multi_action_safe_ask",i,f"Express two independent requested effects: {multi[i%5]}.",ASK(),{"selection_count":2,"selection_types":["edge","edge"],"collaborator_count":2},"clarification_required",flags=F(multi_effect=True),extra={"must_express_two_independent_effects":True})
    cond=["Request Top view only if current selection is empty.","Request showing Part 7 only if it is hidden.","Request deleting Fillet 9 only if it is active.","Request fit-selection only if something is selected.","Request suppressing Extrude 5 only if it is active."]
    for i in range(200): add(R,"conditional_safe_ask",i,cond[i%5],ASK(),{"selection_count":1,"selection_types":["edge"]},"clarification_required",flags=F(conditional=True),extra={"must_express_real_condition":True})
    for i in range(200):
        m=i%5
        if m==0: f=f"Fillet {3+i%41}"; desc=f"Request invalid radius -1 mm for {f}."; lits=[f,"-1 mm"]
        elif m==1: f=f"Draft {3+i%41}"; desc=f"Request invalid angle 120 deg for {f}."; lits=[f,"120 deg"]
        elif m==2: f=f"Extrude {3+i%41}"; desc=f"Request invalid depth 0 mm for {f}."; lits=[f,"0 mm"]
        elif m==3: f=f"Part {3+i%41}"; desc=f"Request invalid linear pattern count 1 for {f} with spacing 5 mm."; lits=[f,"1","5 mm"]
        else: f=f"Fillet {3+i%41}"; desc=f"Request invalid radius -2 mm for {f}."; lits=[f,"-2 mm"]
        add(R,"invalid_quantity_safe_ask",i,desc,ASK(),safety="clarification_required",lits=lits,flags=F(invalid_quantity=True),extra={"must_preserve_invalid_value":True})
    amb=["Request hiding either Part 4 or Part 7, but leave which one is intended unresolved.","Request deleting either Fillet 4 or Fillet 6, but leave which one is intended unresolved.","Request selecting a deictic face with no grounded face id.","Request selecting a deictic edge with no grounded edge id."]
    for i in range(200):
        lits=[["Part 4","Part 7"],["Fillet 4","Fillet 6"],[],[]][i%4]
        add(R,"ambiguous_target_safe_ask",i,amb[i%4],ASK(),safety="clarification_required",lits=lits,flags=F(ambiguous=True),extra={"must_preserve_ambiguity":True})

    design=["Choose a better bracket shape while preserving stiffness and lowering mass.","Redesign for lower manufacturing cost without sacrificing function.","Optimize geometry for fatigue life.","Choose best geometry for high-volume manufacturing.","Redesign for robustness under parameter changes."]
    advanced=["Choose and build an appropriate multi-profile loft.","Determine and apply a complete engineering constraint scheme.","Produce a complete manufacturing drawing for an assembly.","Choose an appropriate shell strategy and thickness.","Choose and apply the correct mate between two faces."]
    for i in range(100): add(R,"scope_boundary_design",i,design[i%5],THINK(),safety="design_escalation",scope="design_or_engineering_judgment")
    for i in range(100): add(R,"scope_boundary_advanced",i,advanced[i%5],ASK(),safety="out_of_contract",scope="advanced_beyond_apprentice_contract")
    assert len(R)==10000
    A=[x for x in R if x["scope"]=="apprentice"]; X=[x for x in R if x["scope"]!="apprentice"]
    assert len(A)==9800 and len(X)==200
    return R,A,X

def lang_view(s):
    return {k:s[k] for k in ["scenario_id","family","semantic_description","context","value_provenance","expected_flags","realization_constraints"]}

def dump(path,rows):
    with open(path,"w",encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n")

def main():
    p=argparse.ArgumentParser(); p.add_argument("--out-dir",required=True); a=p.parse_args()
    out=pathlib.Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    U,A,X=build(); dump(out/"scenario-universe.jsonl",U); dump(out/"apprentice-scenarios.jsonl",A); dump(out/"language-input-attempt1.jsonl",[lang_view(x) for x in A])
    (out/"scope-filter.json").write_text(json.dumps({"candidate_scenarios":10000,"filtered_before_language":200,"scored_scenarios":9800,"reasons":{"design_or_engineering_judgment":100,"advanced_beyond_apprentice_contract":100},"filtered_ids":[x["scenario_id"] for x in X],"router_output_used":False,"language_generated_before_filter":False},ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"candidate":10000,"apprentice":9800,"filtered":200}))

if __name__=="__main__": main()
