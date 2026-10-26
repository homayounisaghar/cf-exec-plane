import {executeLocalBrowserAction} from "./browser_executor.mjs";
import {parseLocalBrowserAction} from "./local_capabilities.mjs";
import {normalizeDigits} from "./date_resolver.mjs";
import {getRanaCapability} from "./rana_catalog.mjs";
import {executeCatalogCapability} from "./rana_catalog_executor.mjs";
import {executeSupportedLocalDataStep,verifyFullRecipeCompletion} from "./rana_step_pipeline.mjs";
import {verifyTelegramOrdering} from "./telegram_order_contract.mjs";
import {verifyTelegramConversationCount} from "./telegram_count_contract.mjs";
import {parseTypedPlan} from "./dexa_tool_plan_v3.mjs";
import {executeTypedPlan} from "./dexa_tool_plan_executor_v3.mjs";
import {openWorkflow} from "./dexa_workflow_kernel.mjs";
import {catalogEffectClass} from "./dexa_effect_contract_v1.mjs";
import {catalogRoute} from "./dexa_catalog_registry.mjs";

const SPECIAL = new Set(["LOCAL","UNRESOLVED","NEEDS_CONTEXT","-"]);

export function parseRecipe(raw, allowedCapabilities = []) {
  if (typeof raw !== "string" || raw.length > 35000) throw Error("RECIPE_INVALID_TEXT");
  if (raw.trimStart().startsWith("{")) {
    const typed=parseTypedPlan(raw,allowedCapabilities);
    if(typed.status==="NEEDS_INPUT")return [{
      id:1,kind:"CLARIFY",type:"E",deps:[],capabilityId:"NEEDS_CONTEXT",
      action:"Structured plan needs owner input",missing:typed.missing
    }];
    if(typed.status==="UNRESOLVED")return [{
      id:1,kind:"UNRESOLVED",type:"E",deps:[],capabilityId:"UNRESOLVED",
      action:"Selected catalog has no executable route",unresolvedReason:typed.reason
    }];
    return typed.steps;
  }
  const clean = raw.trim();
  if (!/^1\|[ET]\|/.test(clean) || /[\r\n]/.test(raw) || raw.includes(String.fromCharCode(96))) {
    throw Error("RECIPE_NOT_SINGLE_PHYSICAL_LINE");
  }
  const steps = [];
  for (const piece of clean.split(";")) {
    const fields = piece.split("|");
    if (fields.length !== 5) throw Error("RECIPE_FIELD_COUNT");
    const [rawId, type, action, dependencies, capabilityId] = fields;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id !== steps.length + 1 || !["E","T"].includes(type)) throw Error("RECIPE_ID_OR_TYPE");
    if (!action.trim() || action.includes(";") || !action.trim().match(/[a-z]/i)) throw Error("RECIPE_ACTION_INVALID");
    const deps = dependencies === "-" ? [] : dependencies.split(",").map(x => {
      if (!/^[1-9]\d*$/.test(x)) throw Error("RECIPE_BAD_DEPENDENCY");
      const d = Number(x);
      if (d >= id) throw Error("RECIPE_FORWARD_DEPENDENCY");
      return d;
    });
    if (new Set(deps).size !== deps.length) throw Error("RECIPE_DUPLICATE_DEPENDENCY");
    if (type === "T" && capabilityId !== "-") throw Error("RECIPE_T_WITH_TOOL");
    if (type === "E" && (capabilityId === "-" ||
        (!SPECIAL.has(capabilityId) && !allowedCapabilities.includes(capabilityId)))) {
      throw Error("RECIPE_UNKNOWN_CAPABILITY");
    }
    steps.push({id, type, action: action.trim(), deps, capabilityId});
  }
  if (steps.length > 20) throw Error("RECIPE_TOO_MANY_STEPS");
  return steps;
}

function parseExactSum(request) {
  const normalized = normalizeDigits(request);
  const match = normalized.match(/(?:^|[^\w])(\d{1,6})\s*\+\s*(\d{1,6})(?!\d)/);
  if (!match || !/(محاسبه|جمع|حاصل|نتیجه|compute|calculate|sum)/i.test(normalized)) return null;
  const lhs = Number(match[1]), rhs = Number(match[2]), result = lhs + rhs;
  if (!Number.isSafeInteger(result) || BigInt(result) !== BigInt(lhs) + BigInt(rhs)) return null;
  return {lhs, rhs, result};
}

function receiptFor(mission, step, startedAt, result, status) {
  // Preserve actual streaming execution time. Otherwise a cached step #2
  // appears to start before the freshly recorded receipt of step #1,
  // falsely violating the full-plan chronological dependency check.
  const endedAt = result?.evidence?.streamedPrefetch===true &&
    typeof result.evidence.earlyStepFinishedAt==="string"?
    result.evidence.earlyStepFinishedAt:new Date().toISOString();
  return {
    receiptId: mission.id + ":plan-" + String(mission.planVersion || 1) + ":step-" + step.id + ":" + endedAt,
    missionId: mission.id,
    planVersion: mission.planVersion || 1,
    plannerMode: mission.provenance?.plannerMode || "UNKNOWN",
    providerMode: mission.provenance?.providerMode || "UNQUALIFIED",
    goalClass: mission.provenance?.goalClass || "UNKNOWN",
    stepId: step.id,
    capabilityId: step.capabilityId,
    operation: result.operation || step.action,
    status,
    effectClass: "READ_ONLY",
    startedAt,
    completedAt: endedAt,
    elapsedMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    evidence: result.evidence || {},
    observationFingerprint: result.observation?.pageFingerprint || null,
    resultVerified: result.status === "GOAL_VERIFIED"
  };
}

export async function executeBoundedReadOnly(mission, steps, {
  onUpdate = async () => {}, onReceipt = async () => {},
  onStepStart = async () => {}, onStepComplete = async () => {},
  onBeforeStep = async () => null,
  onStepOutcome = async () => {},
  consumeEarlyResult = async () => null,
  workflowStoreDir = null, bilingualVerifiedLabels = [], writerInvoker = null,
  verifiedFileRead = async()=>null
} = {}) {
  if (!Array.isArray(steps) || !steps.length) throw Error("EMPTY_PLAN");
  if(mission?.recipeRaw?.trimStart().startsWith("{")&&steps[0]?.kind==="CLARIFY"){
    const fields=Array.isArray(steps[0].missing)?steps[0].missing:[];
    const question=fields.map(x=>String(x.question||"").slice(0,400)).join(" ").slice(0,1200);
    return {state:"WAITING_USER_DECISION",reason:"TOOL_PLAN_NEEDS_INPUT",
      result:question||"برای ادامه، مشخصهٔ دقیق‌تری لازم است.",
      userQuestion:question||"برای ادامه، مشخصهٔ دقیق‌تری لازم است.",
      proof:{effectsExecuted:0,missingFields:fields.map(x=>x.field),typedPlanSchema:"dexa.tool-plan.v3"}};
  }
  if(mission?.recipeRaw?.trimStart().startsWith("{")&&steps[0]?.kind==="UNRESOLVED"){
    return {state:"FAILED",reason:"TOOL_PLAN_UNRESOLVED",
      result:"کاتالوگ منتخب قابلیت کافی برای اجرای این عملیات ندارد.",
      proof:{effectsExecuted:0,modelReason:String(steps[0].unresolvedReason||"").slice(0,500),
       typedPlanSchema:"dexa.tool-plan.v3"}};
  }
  if (["TOOL","TRANSFORM","USER_GATE"].includes(steps[0]?.kind)) {
    const selected=mission?.plans?.at(-1)?.selectedCapabilityIds;
    if (!Array.isArray(selected) || !mission?.recipeRaw?.trimStart().startsWith("{"))
      return {state:"FAILED",reason:"TYPED_PLAN_PROVENANCE_MISSING",
        result:"رسپی بدون ارجاع به قابلیت‌های اولیه تأیید نشد؛ هیچ عملیاتی اجرا نشد.",
        proof:{effectsExecuted:0,initialPlanRejected:true,executionEntered:false}};
    let workflow=null;
    try{
      workflow=workflowStoreDir?
        await openWorkflow({storeDir:workflowStoreDir,missionId:mission.id,
         planVersion:mission.planVersion||1,planRaw:mission.recipeRaw,steps}):null;
    }catch(err){
      return {state:"OUTCOME_UNKNOWN",
       reason:String(err?.code||"WORKFLOW_CHECKPOINT_UNREADABLE"),
       result:"checkpoint رسپی قابل‌اعتبارسنجی نیست؛ هیچ ابزار تکرار نمی‌شود.",
       proof:{component:"workflow_kernel",effectsExecuted:0}};
    }
    if(workflow){
      const summary=workflow.summary();
      const oldReceipts=(mission.stepReceipts||[]).some(r=>
        r.planVersion===(mission.planVersion||1) && r.resultVerified===true);
      const uncertainLegacy=!!mission.activeStep&&!!mission.recoveredAt;
      if((oldReceipts||uncertainLegacy) && summary.revision===0){
        return {state:"OUTCOME_UNKNOWN",reason:"WORKFLOW_LEGACY_STATE_NOT_CHECKPOINTED",
         result:"رسیدهای نسخهٔ قدیمی بدون خروجی پایدار وجود دارند؛ گام قبلی دوباره اجرا نمی‌شود.",
         proof:{component:"workflow_kernel",effectsExecuted:0}};
      }
    }
    const recordTypedReceipt=async receipt=>{
      const index=steps.findIndex(s=>s.id===receipt.stepId);
      if(index<0)throw Error("TYPED_RECEIPT_STEP_UNKNOWN");
      const step=steps[index];
      const proof={
        backend:receipt.evidenceKind,
        physicalTool:receipt.physicalTool||null,
        inputDigest:receipt.inputDigest||null,
        outputDigest:receipt.outputDigest,
        sourceStep:receipt.sourceStep,
        providerDurationMs:receipt.providerDurationMs,
        resultHash:receipt.outputDigest,
        matchEvidence:receipt.matchEvidence||null,
        asyncAdapterId:receipt.asyncAdapterId||null,
        asyncStatusCapabilityId:receipt.asyncStatusCapabilityId||null,
        asyncTerminalStatus:receipt.asyncTerminalStatus||null,
        effectProof:receipt.effectProof||null,
        replayedFromReceiptId:receipt.replayedFromReceiptId||null,
        artifactInputRefs:receipt.artifactInputRefs||[],
        asyncRequestIdDigest:receipt.asyncRequestIdDigest||null,
        asyncStatusProviderTool:receipt.asyncStatusProviderTool||null,
        workflowDurableCheckpoint:!!workflow,
        typedPlanSchema:"dexa.tool-plan.v3"
      };
      await onReceipt({
        receiptId:mission.id+":"+receipt.receiptId,
        missionId:mission.id,planVersion:mission.planVersion||1,
        plannerMode:mission.provenance?.plannerMode||"UNKNOWN",
        providerMode:mission.provenance?.providerMode||"UNQUALIFIED",
        goalClass:mission.provenance?.goalClass||"UNKNOWN",
        stepId:receipt.stepId,capabilityId:step.capabilityId,
        operation:step.kind==="TOOL"?step.capabilityId:
          step.kind==="USER_GATE"?"USER_GATE":step.op,
        status:"SUCCEEDED_VERIFIED",
        effectClass:step.kind==="TOOL"?catalogEffectClass(catalogRoute(step.capabilityId)):"PURE_LOCAL",
        startedAt:receipt.startedAt,completedAt:receipt.completedAt,
        elapsedMs:Math.max(0,Date.parse(receipt.completedAt)-Date.parse(receipt.startedAt)),
        evidence:proof,observationFingerprint:null,resultVerified:true
      });
    };
    return executeTypedPlan(mission.recipeRaw,{
      allowedCapabilities:selected,workflow,bilingualVerifiedLabels,
      ownerGoal:mission.universalRuntimeVersion?mission.text:null,
      writerInvoker,
      onVerifiedFileRead:verifiedFileRead,
      onOperationOutcome:async outcome=>{
       await onStepOutcome(outcome);
       if(outcome.status!=="SUCCEEDED_VERIFIED"){
        const step=steps.find(s=>s.id===outcome.stepId);
        const index=steps.findIndex(s=>s.id===outcome.stepId);
        await onStepComplete(step,index,{status:outcome.status,
         reasonCode:outcome.reasonCode||null,replayed:outcome.replayed===true});
       }
      },
      onProgress:async ({phase,waitMs})=>{
        // No extra Telegram calls and no owner-private content. A long
        // gateway-enforced pause is an active, known wait rather than a
        // silently frozen execution step. Remain EXECUTING (blue).
        if(phase==="RATE_WINDOW_WAIT"){
          const seconds=Math.max(1,Math.ceil(Number(waitMs||0)/1000));
          await onUpdate("EXECUTING",
            "مکث موقت برای سهمیهٔ سرویس تلگرام؛ اجرای مأموریت پس از حدود "+seconds+
            " ثانیه ادامه پیدا می‌کند.");
        }else if(phase==="RATE_WINDOW_RESUME"){
          await onUpdate("EXECUTING",
            "سهمیهٔ سرویس باز شد؛ دکسا بررسی پیام‌های گروه‌ها را ادامه می‌دهد.");
        }else if(phase==="BUSY_ADMISSION_WAIT"){
          await onUpdate("EXECUTING",
            "سرویس تلگرام مشغول است؛ دکسا در انتظار پذیرش خواندن بعدی است.");
        }
      },
      onBeforeStep,
      onStep:async ({stepId})=>{
        const index=steps.findIndex(s=>s.id===stepId);
        if(index<0)throw Error("TYPED_STEP_NOT_IN_STORED_PLAN");
        await onStepStart(steps[index],index);
        await onUpdate("EXECUTING","رانا مرحلهٔ ساخت یافته "+stepId+" را با شمای کاتالوگ بررسی می کند.");
      },
      onReceipt:async receipt=>{
        await recordTypedReceipt(receipt);
        const step=steps.find(s=>s.id===receipt.stepId);
        const index=steps.findIndex(s=>s.id===receipt.stepId);
        await onStepComplete(step,index,{
         status:"GOAL_VERIFIED",operation:step.op||step.capabilityId
        });
      },
      onReplay:async ({step,receipt})=>{
        // Repair a crash gap: checkpoint was fsync'd, but main mission JSON
        // might have lost its receipt or nextStepIndex. Never run the tool again.
        await recordTypedReceipt(receipt);
        const index=steps.findIndex(s=>s.id===step.id);
        await onStepComplete(step,index,{
         status:"GOAL_VERIFIED",operation:step.op||step.capabilityId,
         replayedDurableCheckpoint:true
        });
      }
    });
  }
  const effects = steps.filter(step => step.type === "E");
  if (steps.length === 1 && effects.length === 1 && effects[0].capabilityId === "LOCAL") {
    const sum = parseExactSum(mission.text);
    if (sum) {
      const step = effects[0];
      const startedAt = new Date().toISOString();
      await onStepStart(step, 0);
      await onUpdate("VERIFYING", "رانا محاسبهٔ محلی را مستقلاً بررسی می‌کند.");
      const fa = n => new Intl.NumberFormat("fa-IR").format(n);
      const result = {
        state: "SUCCEEDED_VERIFIED",
        result: "محاسبه انجام شد و نتیجه تأیید شد: " + fa(sum.lhs) + " + " + fa(sum.rhs) + " = " + fa(sum.result),
        reason: "EXACT_LOCAL_OPERATION",
        proof: {operation: "LOCAL_INTEGER_ADDITION", ...sum, independentBigIntCheck: true,
          localOperationsExecuted: 1, effectsExecuted: 0}
      };
      await onReceipt({
        receiptId: mission.id + ":plan-" + String(mission.planVersion || 1) + ":step-" + step.id,
        missionId: mission.id, planVersion: mission.planVersion || 1, stepId: step.id,
        plannerMode:mission.provenance?.plannerMode || "UNKNOWN",
        providerMode:mission.provenance?.providerMode || "UNQUALIFIED",
        goalClass:mission.provenance?.goalClass || "UNKNOWN",
        capabilityId: step.capabilityId, operation: "LOCAL_INTEGER_ADDITION",
        status: "SUCCEEDED_VERIFIED", effectClass: "PURE_LOCAL", startedAt,
        completedAt: new Date().toISOString(), elapsedMs: 0,
        evidence: {lhs: sum.lhs, rhs: sum.rhs, result: sum.result, independentBigIntCheck: true},
        observationFingerprint: null, resultVerified: true
      });
      await onStepComplete(step, 0, {status: "GOAL_VERIFIED"});
      return result;
    }
  }

  const receipts = [];
  const outputs = new Map();
  let verifiedGoal = null;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    let startedAt = new Date().toISOString();
    if((step.deps||[]).some(id=>!outputs.has(id))){
      return {state:"REPLAN_REQUIRED",reason:"RANA_DEPENDENCY_RESULT_MISSING",
        failedStepId:step.id,remainingSteps:steps.slice(index),
        result:"خروجی تأییدشدهٔ یکی از مراحل پیش‌نیاز در دسترس نیست.",
        proof:{completedReceiptIds:receipts.map(r=>r.receiptId),effectsExecuted:0}};
    }
    if (step.type === "T") {
      return {
        state: "REPLAN_REQUIRED", reason: "SEMANTIC_STEP_NOT_HOST_VERIFIABLE",
        result: "رسپی شامل قضاوتی است که رانا هنوز نمی‌تواند مستقلاً با شواهد میزبان تأیید کند.",
        failedStepId: step.id, remainingSteps: steps.slice(index),
        proof: {completedReceipts: receipts.map(r => r.receiptId), effectsExecuted: 0}
      };
    }
    if (step.capabilityId === "UNRESOLVED" || step.capabilityId === "NEEDS_CONTEXT") {
      return {
        state: "REPLAN_REQUIRED",
        reason: step.capabilityId === "UNRESOLVED" ? "PLANNER_UNRESOLVED_CAPABILITY" : "PLANNER_NEEDS_CONTEXT",
        result: "کاتالوگ اولیه مسیر مناسبی نشان نداد؛ رانا باید وضعیت واقعی را ثبت و برای ادامه بازبرنامه‌ریزی کند.",
        failedStepId: step.id, remainingSteps: steps.slice(index),
        proof: {completedReceipts: receipts.map(r => r.receiptId), effectsExecuted: 0}
      };
    }
    if(step.capabilityId !== "LOCAL" && getRanaCapability(step.capabilityId)) {
      await onStepStart(step,index);
      await onUpdate("EXECUTING","رانا در حال فراخوانی قابلیت کاتالوگ "+step.capabilityId+" است.");
      const early=await consumeEarlyResult({
        mission,step,isTerminalStep:index===steps.length-1
      });
      if(early?.startedAt)startedAt=early.startedAt;
      const provider=early?.result ||
        await executeCatalogCapability({mission,step,isTerminalStep:index===steps.length-1});
      const result=early?{...provider,evidence:{
        ...(provider.evidence||{}),streamedPrefetch:true,
        firstPacketAt:early.firstPacketAt,
        earlyStepStartedAt:early.startedAt,
        earlyStepFinishedAt:early.completedAt
      }}:provider;
      const status=result.status==="GOAL_VERIFIED"?"SUCCEEDED_VERIFIED":"REPLAN_REQUIRED";
      const receipt=receiptFor(mission,step,startedAt,result,status);
      receipts.push(receipt);
      await onReceipt(receipt);
      await onStepComplete(step,index,result);
      if(result.status==="GOAL_VERIFIED" && result.result){
        outputs.set(step.id,result.result);
        verifiedGoal={reason:"CATALOG_PROVIDER_READ_VERIFIED",evidence:result.evidence,
          providerResultHash:result.evidence?.resultHash,
          capabilityId:step.capabilityId,latestResult:result.result};
        await onUpdate("EXECUTING","گام "+step.id+" تأیید شد؛ اجرای سایر مراحل رسپی ادامه دارد.");
        continue;
      }
      return {state:"REPLAN_REQUIRED",reason:result.reason||"CATALOG_EXECUTOR_REPLAN",
        result:"گام "+step.id+" از رسپی با نتیجهٔ قابل‌تأیید تمام نشد.",
        failedStepId:step.id,remainingSteps:steps.slice(index),
        proof:{...(result.evidence||{}),completedReceiptIds:receipts.map(r=>r.receiptId),
          effectsExecuted:0}};
    }
    if(step.capabilityId==="LOCAL" && (step.deps||[]).length){
      const early=await consumeEarlyResult({
        mission,step,isTerminalStep:index===steps.length-1
      });
      if(early?.startedAt)startedAt=early.startedAt;
      const base=early?.result || executeSupportedLocalDataStep(step,outputs,{missionText:mission.text});
      const local=early?{...base,evidence:{
        ...(base.evidence||{}),streamedPrefetch:true,
        firstPacketAt:early.firstPacketAt,
        earlyStepStartedAt:early.startedAt,
        earlyStepFinishedAt:early.completedAt
      }}:base;
      if(local.status!=="UNSUPPORTED"){
        await onStepStart(step,index);
        await onUpdate("EXECUTING","رانا در حال اجرای تبدیل محلیِ گام "+step.id+" است.");
        const receipt=receiptFor(mission,step,startedAt,local,
          local.status==="GOAL_VERIFIED"?"SUCCEEDED_VERIFIED":"REPLAN_REQUIRED");
        receipt.effectClass="PURE_LOCAL";
        receipts.push(receipt);
        await onReceipt(receipt);
        await onStepComplete(step,index,local);
        if(local.status==="GOAL_VERIFIED"&&local.result){
          outputs.set(step.id,local.result);
          if(verifiedGoal)verifiedGoal.latestResult=local.result;
          await onUpdate("EXECUTING","خروجی مرحلهٔ "+step.id+" محاسبه و تأیید شد.");
          continue;
        }
        return {state:"REPLAN_REQUIRED",reason:local.reason||"LOCAL_STEP_UNSUPPORTED",
          result:"تبدیل محلیِ این مرحله قابل‌تأیید نیست.",
          failedStepId:step.id,remainingSteps:steps.slice(index),
          proof:{completedReceiptIds:receipts.map(r=>r.receiptId),effectsExecuted:0}};
      }
    }
    if (step.capabilityId !== "LOCAL" && (() => {
      try { parseLocalBrowserAction(step.action); return false; } catch { return true; }
    })()) {
      return {
        state: "REPLAN_REQUIRED", reason: "CAPABILITY_NOT_BOUND_IN_DEXA_RUNTIME",
        result: "قابلیت انتخاب‌شده در کاتالوگ به مجری قابل‌فراخوانی در زمان اجرای دکسا متصل نیست.",
        failedStepId: step.id, remainingSteps: steps.slice(index),
        proof: {capabilityId: step.capabilityId, completedReceipts: receipts.map(r => r.receiptId), effectsExecuted: 0}
      };
    }

    let parsed;
    try { parsed = parseLocalBrowserAction(step.action); }
    catch {
      return {
        state: "REPLAN_REQUIRED", reason: "LOCAL_ACTION_NOT_ADMITTED",
        result: "عمل پیشنهادی در فهرست محدود عملیات خواندنی میزبان نیست؛ اجرای کد یا دستور دلخواه مجاز نیست.",
        failedStepId: step.id, remainingSteps: steps.slice(index),
        proof: {actionRejected: true, completedReceipts: receipts.map(r => r.receiptId), effectsExecuted: 0}
      };
    }

    await onStepStart(step, index);
    await onUpdate("EXECUTING", "رانا در حال اجرای گام خواندنی " + step.id + " است.");
    // Strictly offline fault injection: delay after the durable STEP_STARTED event,
    // before a browser operation; never active without the synthetic planner and loopback origin.
    if (process.env.DEXA_TEST_MODE === "1" && process.env.DEXA_SYNTHETIC_PLANNER === "1" &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.DEXA_BROWSER_ALLOWED_ORIGINS || "") &&
        step.action === process.env.DEXA_SYNTHETIC_PAUSE_ACTION) {
      const ms = Math.min(30000, Math.max(0, Number(process.env.DEXA_SYNTHETIC_PAUSE_MS) || 0));
      if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
    }
    let result;
    try {
      const early=await consumeEarlyResult({
        mission,step,isTerminalStep:index===steps.length-1
      });
      if(early?.startedAt)startedAt=early.startedAt;
      const base=early?.result ||
        await executeLocalBrowserAction({missionId: mission.id, mission, action: step.action});
      result=early?{...base,evidence:{
        ...(base.evidence||{}),streamedPrefetch:true,
        firstPacketAt:early.firstPacketAt,
        earlyStepStartedAt:early.startedAt,
        earlyStepFinishedAt:early.completedAt
      }}:base;
    } catch (error) {
      const code = String(error?.code || error?.message || "BROWSER_EXECUTOR_ERROR").slice(0, 120);
      const waiting = ["BROWSER_TAB_MISSING","BROWSER_TAB_NOT_UNIQUE",
        "TAPSI_LOGIN_REQUIRED"].includes(code);
      const failed = {status: waiting ? "WAITING_USER_AUTH" : "REPLAN_REQUIRED",
        reason: code, evidence: {executorError: code}};
      const receipt = receiptFor(mission, step, startedAt, failed, waiting ? "WAITING_USER_AUTH" : "REPLAN_REQUIRED");
      receipts.push(receipt);
      await onReceipt(receipt);
      await onStepComplete(step, index, failed);
      if (waiting) {
        return {
          state: "WAITING_USER_AUTH", reason: code,
          result: "دکسا به یک نشست مجاز و یکتای " +
            (mission?.successContract?.provider?.name || "ارائه‌دهنده") +
            " دسترسی ندارد. مرورگر را باز کن، وارد حساب شو و از دکسا ادامه را درخواست کن.",
          failedStepId: step.id, remainingSteps: steps.slice(index),
          proof: {executorError: code, effectsExecuted: 0}
        };
      }
      return {
        state: "REPLAN_REQUIRED", reason: code,
        result: "اجرای گام خواندنی با وضعیت قابل‌تأیید ادامه پیدا نکرد؛ وضعیت واقعی باید دوباره مشاهده شود.",
        failedStepId: step.id, remainingSteps: steps.slice(index),
        proof: {executorError: code, effectsExecuted: 0}
      };
    }

    if (result.observation) mission.lastObservation = result.observation;
    if (result.contextPatch) mission.executionContext = {...(mission.executionContext || {}), ...result.contextPatch};

    const status = result.status === "GOAL_VERIFIED" ? "SUCCEEDED_VERIFIED" :
      result.status === "STEP_COMPLETED" ? "STEP_COMPLETED" :
      result.status === "WAITING_USER_AUTH" ? "WAITING_USER_AUTH" :
      result.status === "WAITING_USER_DECISION" ? "WAITING_USER_DECISION" : "REPLAN_REQUIRED";
    const receipt = receiptFor(mission, step, startedAt, result, status);
    receipts.push(receipt);
    await onReceipt(receipt);
    await onStepComplete(step, index, result);
    if (result.status === "WAITING_USER_AUTH") {
      return {state: "WAITING_USER_AUTH", reason: result.reason || "AUTH_REQUIRED",
        result: "ورود به حساب برای ادامه لازم است. پس از ورود، از خود دکسا ادامه را درخواست کن.",
        failedStepId: step.id, remainingSteps: steps.slice(index), proof: result.evidence || {}};
    }
    if (result.status === "WAITING_USER_DECISION") {
      return {state: "WAITING_USER_DECISION", reason: result.reason || "AMBIGUOUS_RECORD",
        result: "بیش از یک سابقه با معیارهای فعلی جور است؛ برای جلوگیری از انتخاب اشتباه به یک مشخصهٔ بیشتر نیاز است.",
        failedStepId: step.id, remainingSteps: steps.slice(index), proof: result.evidence || {}};
    }

    if (result.status === "GOAL_VERIFIED") {
      const details = result.result?.courierDetails || {};
      const lines = ["سابقهٔ پیک با تاریخ و مبلغ درخواستی تطبیق داده شد."];
      if (details.courierName) lines.push("نام پیک: " + details.courierName);
      if (details.courierPhone) lines.push("شمارهٔ تماس نمایش‌داده‌شده: " + details.courierPhone);
      if (details.courierVehicle) lines.push("وسیلهٔ نقلیه: " + details.courierVehicle);
      outputs.set(step.id,result.result||{});
      verifiedGoal={reason:"MATCHING_PROVIDER_RECORD_AND_COURIER_FIELDS_VERIFIED",
        evidence:{...(result.evidence||{}),record:result.result?.record,courierDetails:details},
        latestResult:{display:lines.join("\n")}};
      await onUpdate("EXECUTING","گام "+step.id+" تأیید شد؛ اجرای مراحل باقی‌مانده ادامه دارد.");
      continue;
    }
    if (result.status !== "STEP_COMPLETED") {
      return {
        state: "REPLAN_REQUIRED", reason: result.reason || "EXECUTOR_REPLAN_REQUIRED",
        result: "رانا در وضعیت فعلی نمی‌تواند گام بعدی را با اطمینان اجرا کند؛ نقطهٔ کنترل و شواهد تازه لازم است.",
        failedStepId: step.id, remainingSteps: steps.slice(index),
        proof: {...(result.evidence || {}), completedReceiptIds: receipts.map(r => r.receiptId), effectsExecuted: 0}
      };
    }
    outputs.set(step.id,result.result||result.observation||result.contextPatch||{});
    await onUpdate("EXECUTING", "گام " + step.id + " اجرا شد؛ نتیجهٔ واقعی ثبت شد.");
  }

  // A verified provider read does NOT finish a multi-step plan.
  const complete=verifyFullRecipeCompletion(steps,receipts,mission.planVersion||1);
  if(verifiedGoal&&complete.ok){
    const last=steps.at(-1);
    const output=verifiedGoal.latestResult;
    const resultText=typeof output?.display==="string"?output.display:"";
    if(!resultText){
      return {state:"REPLAN_REQUIRED",reason:"RANA_FINAL_RESULT_MISSING",
        failedStepId:last.id,remainingSteps:[],proof:{...complete,effectsExecuted:0}};
    }
    let taskOrderProof={};
    let taskCountProof={};
    if(verifiedGoal.capabilityId==="telegram.conversation.list"){
      taskCountProof=verifyTelegramConversationCount({
        missionText:mission.text,records:output?.conversations
      });
      if(!taskCountProof.ok)return {state:"REPLAN_REQUIRED",
        reason:"TELEGRAM_GOAL_COUNT_NOT_VERIFIED",
        result:"تعداد چت‌های نتیجه با تعداد خواسته‌شده در مأموریت برابر نیست.",
        failedStepId:last.id,remainingSteps:[],
        proof:{...complete,expectedCount:taskCountProof.count,
          actualCount:taskCountProof.actualCount,effectsExecuted:0}};
      taskOrderProof=verifyTelegramOrdering({
        missionText:mission.text,records:output?.conversations
      });
      if(!taskOrderProof.ok)return {state:"REPLAN_REQUIRED",
        reason:"TELEGRAM_GOAL_ORDER_NOT_VERIFIED",
        result:"ترتیب نهایی گفت‌وگوها با ترتیب درخواستی مأموریت سازگار نیست.",
        failedStepId:last.id,remainingSteps:[],
        proof:{...complete,expectedOrder:taskOrderProof.expectedOrder,
          checkedRows:taskOrderProof.checkedRows,effectsExecuted:0}};
    }
    return {state:"SUCCEEDED_VERIFIED",result:resultText,reason:verifiedGoal.reason,
      proof:{...(verifiedGoal.evidence||{}),capabilityId:verifiedGoal.capabilityId,
        goalOrderVerified:taskOrderProof.ok===true,
        goalOrder:taskOrderProof.expectedOrder||null,
        goalCountVerified:taskCountProof.ok===true,
        goalCount:taskCountProof.count||null,
        resultHash:verifiedGoal.providerResultHash||verifiedGoal.evidence?.resultHash,
        finalResultHash:receipts.at(-1)?.evidence?.resultHash || verifiedGoal.providerResultHash,
        ...complete,effectsExecuted:0}};
  }
  return {
    state: "REPLAN_REQUIRED", reason:complete.ok?
      "RECIPE_ENDED_WITHOUT_VERIFIED_GOAL":"RECIPE_STEPS_NOT_ALL_VERIFIED",
    result: "رسپی بدون تکمیل و تأیید همهٔ گام‌ها یا بدون اثبات هدف اصلی تمام شد.",
    failedStepId: steps.at(-1)?.id, remainingSteps: [],
    proof: {...complete,effectsExecuted:0}
  };

}
