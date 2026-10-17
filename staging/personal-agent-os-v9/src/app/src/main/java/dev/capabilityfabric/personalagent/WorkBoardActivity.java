package dev.capabilityfabric.personalagent;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

/** Compact direct-first task cockpit; provider-unknown results must never appear DONE. */
public final class WorkBoardActivity extends Activity {
  // First three use live bounded read-only VPS work handlers.
  // The last two are future CF integration lanes and remain intentionally QUEUED.
  private static final String[] IDS={"agentos","vps","queue","onshape","telegram"};
  private static final String[] NAMES={"عامل شخصی","سلامت سرور","صف فرمان‌ها","آنشیپ","تلگرام"};
  private static final String[] QUERIES={
    "وضعیت پروژه Personal Agent OS را بررسی کن",
    "سلامت VPS و وضعیت سرور را بررسی کن",
    "تعداد فرمان‌های صف را بررسی کن",
    "وضعیت آنشیپ را بررسی کن",
    "تعداد گفتگوهای ناخواندهٔ تلگرام را بررسی کن"
  };
  private LinearLayout root,cards;
  private TextView state;
  private JSONObject currentBoard,currentLocal;
  private String currentError;
  private boolean refreshing=false,sending=false;
  private int expanded=-1;
  private int dp(int x){return (int)(x*getResources().getDisplayMetrics().density+.5f);}

  private Button button(String s,View.OnClickListener cb){
    Button b=new Button(this);
    b.setText(s);b.setTextSize(14);b.setAllCaps(false);
    b.setOnClickListener(cb);
    b.setMinHeight(dp(48));
    return b;
  }
  private TextView line(String s,int sp,boolean bold){
    TextView t=new TextView(this);
    t.setText(s);t.setTextColor(Color.rgb(32,52,67));
    t.setTextSize(sp);t.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
    t.setGravity(Gravity.RIGHT);t.setPadding(dp(8),dp(4),dp(8),dp(4));
    if(bold)t.setTypeface(null,Typeface.BOLD);
    return t;
  }
  private String safe(JSONObject j,String key){
    if(j==null)return "";
    Object value=j.opt(key);
    return value instanceof String ? (String)value : "";
  }
  private String viewState(String v){
    if("DONE".equals(v))return "انجام شد";
    if("QUEUED".equals(v))return "در صف";
    if("WORKING".equals(v))return "در حال بررسی";
    if("NEEDS_CLARIFICATION".equals(v))return "نیاز به مشخص‌کردن درخواست";
    if("NEEDS_USER".equals(v))return "منتظر تصمیم تو";
    if("REPLY_READY".equals(v))return "پاسخ آماده است";
    if("UNCERTAIN".equals(v))return "وضعیت نامشخص";
    if("FAILED".equals(v))return "ناموفق";
    return v.isEmpty() ? "هنوز شروع نشده" : v;
  }
  @Override public void onCreate(Bundle bundle){
    super.onCreate(bundle);
    if(bundle!=null)expanded=bundle.getInt("open_work",-1);
    getWindow().setStatusBarColor(Color.rgb(23,37,51));
    getWindow().setNavigationBarColor(Color.rgb(23,37,51));
    root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(247,249,252));
    root.setOnApplyWindowInsetsListener((v,insets)->{
      v.setPadding(dp(12),insets.getSystemWindowInsetTop()+dp(6),
        dp(12),insets.getSystemWindowInsetBottom()+dp(6));
      return insets;
    });
    setContentView(root);
    root.addView(line("کارهای من",22,true));
    state=line("در حال دریافت وضعیت سرور...",13,false);root.addView(state);
    root.addView(button("تازه‌کردن نتیجه‌ها",v->refreshBoard()));
    ScrollView scroll=new ScrollView(this);
    root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
    cards=new LinearLayout(this);cards.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(cards);
    root.addView(button("بازگشت به فرمان صوتی یا متنی",v->finish()));
  }
  @Override protected void onSaveInstanceState(Bundle b){
    b.putInt("open_work",expanded);
    super.onSaveInstanceState(b);
  }
  @Override protected void onResume(){super.onResume();if(cards!=null)refreshBoard();}
  private String selected(){
    return getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .getString(AgentOutbox.KEY_WORK,"");
  }
  private void choose(String work){
    boolean done=getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .edit().putString(AgentOutbox.KEY_WORK,work).commit();
    if(done){
      Toast.makeText(this,"کار انتخاب شد: "+work,Toast.LENGTH_SHORT).show();
      finish();
    }else Toast.makeText(this,"ذخیرهٔ انتخاب انجام نشد",Toast.LENGTH_LONG).show();
  }
  private void send(int index){
    if(index<0 || index>=3){state.setText("این اتصال هنوز به اجرای واقعی وصل نیست.");return;}
    if(sending)return;
    sending=true;
    String work=IDS[index];
    boolean stored=getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .edit().putString(AgentOutbox.KEY_WORK,work).commit();
    if(!stored){sending=false;state.setText("انتخاب کار ذخیره نشد");return;}
    try(AgentOutbox out=new AgentOutbox(this)){
      out.enqueueManual(QUERIES[index],work);
    }catch(Exception e){sending=false;state.setText("ثبت فرمان محلی ناموفق بود");return;}
    AgentSyncScheduler.schedule(this);
    state.setText("درخواست ذخیره شد؛ در حال ارسال مستقیم به سرور...");
    new Thread(()->{
      AgentTransport.Report r=AgentTransport.syncOnce(this,12);
      runOnUiThread(()->{
        sending=false;
        state.setText("رسید سرور: "+r.acknowledged+" | منتظر ارسال: "+r.remaining+
          "\nرسید با نتیجهٔ کار فرق دارد.");
        refreshBoard();
      });
    },"agentos-v9-readonly-submit").start();
  }
  private JSONObject readLocal(){
    try(AgentOutbox q=new AgentOutbox(this)){return q.localWorkCounts();}
    catch(Exception e){return new JSONObject();}
  }
  private void refreshBoard(){
    if(refreshing)return;
    refreshing=true;
    state.setText("در حال بررسی کارها...");
    new Thread(()->{
      JSONObject board=null;
      String error=null;
      try{board=AgentTransport.workBoard(this);}
      catch(Exception e){error=e.getClass().getSimpleName();}
      final JSONObject response=board;
      final String reason=error;
      final JSONObject local=readLocal();
      runOnUiThread(()->{
        refreshing=false;
        currentBoard=response;currentLocal=local;currentError=reason;
        renderBoard();
      });
    },"agentos-v9-work-read").start();
  }
  private JSONObject workFrom(JSONArray array,String work){
    if(array==null)return null;
    for(int i=0;i<array.length();i++){
      JSONObject item=array.optJSONObject(i);
      if(item!=null&&work.equals(item.optString("work_id")))return item;
    }
    return null;
  }
  private void renderBoard(){
    cards.removeAllViews();
    if(currentError!=null)state.setText("ارتباط مستقیم قطع است؛ وضعیت قبلی روی سرور حفظ می‌شود. "+
      "برای ارسال دوباره، اتصال VPN را بررسی کن.");
    else if(currentBoard==null)state.setText("اطلاعات سرور هنوز دریافت نشده است.");
    else state.setText("سرور: "+currentBoard.optString("mode","نامشخص")+
      " · دریافت فرمان، با انجام آن متفاوت است.");
    JSONArray works=currentBoard==null?null:currentBoard.optJSONArray("works");
    for(int i=0;i<IDS.length;i++){
      final int index=i;
      final String id=IDS[i];
      JSONObject remote=workFrom(works,id);
      JSONObject local=currentLocal==null?null:currentLocal.optJSONObject(id);
      String rawState=remote==null?"":safe(remote,"state");
      if(rawState.isEmpty()&&remote!=null)rawState=safe(remote,"latest_state");
      boolean available=i<3;
      LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);
      card.setPadding(dp(5),dp(6),dp(5),dp(6));
      GradientDrawable bg=new GradientDrawable();
      bg.setColor(Color.WHITE);bg.setCornerRadius(dp(12));bg.setStroke(dp(1),Color.rgb(224,231,239));
      card.setBackground(bg);
      LinearLayout.LayoutParams margins=new LinearLayout.LayoutParams(-1,-2);
      margins.setMargins(0,dp(5),0,dp(5));cards.addView(card,margins);
      String selectedLabel=id.equals(selected())?" ✓":"";
      String statusText=remote==null?(available?"شروع نشده":"اتصال اجرایی آماده نیست"):viewState(rawState);
      Button heading=button(NAMES[i]+selectedLabel+" · "+statusText+(expanded==i?" −":" +"),v->{
        expanded=expanded==index?-1:index;
        renderBoard();
      });
      card.addView(heading);
      String summary=safe(remote,"result_summary");
      if(expanded!=i){
        if(!summary.isEmpty() && "DONE".equals(rawState)){
          TextView snippet=line(summary,13,false);snippet.setMaxLines(2);card.addView(snippet);
        }else if("NEEDS_CLARIFICATION".equals(rawState)){
          card.addView(line("این درخواست به توضیح بیشتری نیاز دارد.",13,false));
        }else if(!available){
          card.addView(line("پیام‌های قبلی محفوظ‌اند؛ اجرا هنوز وصل نیست.",12,false));
        }
        continue;
      }
      int pending=local==null?0:local.optInt("PENDING",0);
      int acked=local==null?0:local.optInt("ACKED",0);
      card.addView(line("دریافت گوشی: "+acked+" تأییدشده، "+pending+" منتظر ارسال",12,false));
      card.addView(line("سرور: "+statusText+" · تعداد درخواست‌ها: "+
        (remote==null?0:remote.optInt("command_count",remote.optInt("queued_commands",0))),13,true));
      if(!summary.isEmpty())card.addView(line(summary,14,false));
      String ref=safe(remote,"evidence_ref");
      if(!ref.isEmpty())card.addView(line("مدرک: "+ref,11,false));
      JSONArray history=remote==null?null:remote.optJSONArray("history");
      if(history!=null&&history.length()>0){
        card.addView(line("آخرین درخواست‌ها:",12,true));
        for(int j=0;j<history.length() && j<4;j++){
          JSONObject old=history.optJSONObject(j);
          if(old==null)continue;
          String hstate=safe(old,"state");
          String hsummary=safe(old,"result_summary");
          card.addView(line("• "+viewState(hstate)+
            (hsummary.isEmpty()?"":" · "+hsummary),12,false));
        }
      }
      card.addView(button("انتخاب برای گفتار یا متن",v->choose(id)));
      if(available){
        card.addView(button("بررسی وضعیت واقعی",v->send(index)));
      }else{
        card.addView(line("اجرای آنشیپ و تلگرام هنوز به Capability Fabric متصل نشده؛ "+
          "هیچ نتیجهٔ ساختگی نمایش داده نمی‌شود.",12,false));
      }
    }
    cards.addView(line("کارها روی سرور حفظ می‌شوند. برای دیدن سابقهٔ کوتاه هر کار، کارت آن را باز کن.",12,false));
  }
}
