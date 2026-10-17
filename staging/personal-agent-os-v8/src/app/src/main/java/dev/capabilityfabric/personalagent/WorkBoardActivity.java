package dev.capabilityfabric.personalagent;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

/** Direct-first work cockpit: shows verified receipts separately from provider results. */
public final class WorkBoardActivity extends Activity {
  private static final String[] IDS={"onshape","telegram","agentos"};
  private static final String[] NAMES={"آنشیپ","تلگرام","پروژهٔ عامل شخصی"};
  private static final String[] QUERIES={
    "وضعیت آنشیپ و کارهای باز من را بررسی کن",
    "تعداد گفتگوهای ناخواندهٔ تلگرام را بررسی کن",
    "وضعیت کارهای پروژهٔ Personal Agent OS را بررسی کن"
  };
  private LinearLayout root,cards;
  private TextView state;
  private int dp(int x){return (int)(x*getResources().getDisplayMetrics().density+.5f);}
  private Button button(String s, View.OnClickListener cb){
    Button b=new Button(this);b.setText(s);b.setAllCaps(false);b.setTextSize(14);
    b.setOnClickListener(cb);return b;
  }
  private TextView line(String s,int sp,boolean bold){
    TextView t=new TextView(this);t.setText(s);t.setTextColor(Color.rgb(32,52,67));
    t.setTextSize(sp);t.setPadding(dp(4),dp(6),dp(4),dp(6));
    if(bold)t.setTypeface(null,Typeface.BOLD);return t;
  }
  @Override public void onCreate(Bundle b){
    super.onCreate(b);
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
    root.addView(line("Personal Agent OS · کارها",22,true));
    state=line("در حال خواندن وضعیت پایدار سرور...",14,false);root.addView(state);
    root.addView(button("به‌روزرسانی وضعیت",v->refreshBoard()));
    ScrollView scroll=new ScrollView(this);root.addView(scroll,
       new LinearLayout.LayoutParams(-1,0,1));
    cards=new LinearLayout(this);cards.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(cards);
    root.addView(button("بازگشت به فرمان صوتی / متنی",v->finish()));
    refreshBoard();
  }
  @Override protected void onResume(){super.onResume();if(cards!=null)refreshBoard();}
  private String selected(){
    return getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .getString(AgentOutbox.KEY_WORK,"");
  }
  private void choose(String work){
    boolean done=getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .edit().putString(AgentOutbox.KEY_WORK,work).commit();
    if(done){Toast.makeText(this,"کار انتخاب شد: "+work,Toast.LENGTH_SHORT).show();finish();}
    else Toast.makeText(this,"ذخیرهٔ انتخاب انجام نشد",Toast.LENGTH_LONG).show();
  }
  private void send(int index){
    String id=IDS[index];
    boolean stored=getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .edit().putString(AgentOutbox.KEY_WORK,id).commit();
    if(!stored){state.setText("انتخاب کار ذخیره نشد");return;}
    try(AgentOutbox out=new AgentOutbox(this)){out.enqueueManual(QUERIES[index],id);}
    catch(Exception e){state.setText("ثبت فرمان محلی ناموفق بود");return;}
    AgentSyncScheduler.schedule(this);
    state.setText("دستور در صف امن گوشی ذخیره شد؛ در حال همگام‌سازی...");
    new Thread(()->{
      AgentTransport.Report r=AgentTransport.syncOnce(this,8);
      runOnUiThread(()->{
        state.setText("رسید جدید: "+r.acknowledged+" | منتظر: "+r.remaining+
          "\nرسید دریافت، به معنی اجرای دستور نیست.");
        refreshBoard();
      });
    },"agentos-v8-submit").start();
  }
  private JSONObject readLocal() {
    try(AgentOutbox out=new AgentOutbox(this)){return out.localWorkCounts();}
    catch(Exception e){return new JSONObject();}
  }
  private void refreshBoard(){
    state.setText("در حال بررسی مستقیم سرور...");
    new Thread(()->{
      JSONObject board=null;
      String err=null;
      try{board=AgentTransport.workBoard(this);}
      catch(Exception e){err=e.getClass().getSimpleName();}
      final JSONObject data=board;
      final String error=err;
      final JSONObject local=readLocal();
      runOnUiThread(()->renderBoard(data,local,error));
    },"agentos-v8-work-read").start();
  }
  private void renderBoard(JSONObject board,JSONObject local,String err){
    cards.removeAllViews();
    String mode=board==null?"OFFLINE":board.optString("mode","LIVE");
    if(err!=null)state.setText("ارتباط مستقیم در دسترس نیست: "+err+
      "\nاطلاعات محلی حفظ شده؛ نتیجهٔ اجرا تأیید نشده.");
    else state.setText("وضعیت مستقیم سرور: "+mode+
       "\nACKED فقط دریافت پایدار است، نه اتمام کار.");
    JSONArray works=board==null?null:board.optJSONArray("works");
    for(int i=0;i<IDS.length;i++){
      final int at=i;String id=IDS[i];
      JSONObject localItem=local.optJSONObject(id);
      JSONObject remote=null;
      if(works!=null){for(int k=0;k<works.length();k++){
        JSONObject w=works.optJSONObject(k);
        if(w!=null && id.equals(w.optString("work_id"))){remote=w;break;}
      }}
      LinearLayout card=new LinearLayout(this);
      card.setOrientation(LinearLayout.VERTICAL);card.setPadding(dp(8),dp(10),dp(8),dp(10));
      card.setBackgroundColor(Color.WHITE);
      LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);
      lp.setMargins(0,dp(6),0,dp(6));cards.addView(card,lp);
      card.addView(line(NAMES[i]+(id.equals(selected())?"  ✓ انتخاب شده":""),18,true));
      int pending=localItem==null?0:localItem.optInt("PENDING",0);
      int acked=localItem==null?0:localItem.optInt("ACKED",0);
      card.addView(line("گوشی: "+pending+" منتظر ارسال، "+acked+" دریافت تأییدشده",14,false));
      if(remote==null)card.addView(line("سرور: هنوز فرمان ثبت‌شده‌ای برای این کار دیده نشد.",13,false));
      else{
        String st=remote.optString("state",remote.optString("latest_state","QUEUED"));
        String summary=remote.optString("result_summary","");
        int num=remote.optInt("queued_commands",remote.optInt("command_count",0));
        card.addView(line("سرور: "+st+" · فرمان‌های ثبت‌شده: "+num,14,true));
        if(!summary.isEmpty())card.addView(line("نتیجه: "+summary,14,false));
        if(!remote.has("evidence_ref") || remote.isNull("evidence_ref")){
          card.addView(line("مدرک اجرای تأییدشده هنوز وجود ندارد.",12,false));
        } else {
          card.addView(line("مدرک: "+remote.optString("evidence_ref"),12,false));
        }
      }
      card.addView(button("انتخاب این کار برای گفتار/متن",v->choose(id)));
      card.addView(button("درخواست بررسی وضعیت",v->send(at)));
    }
    cards.addView(line("اگر چند کار ممکن باشد، ابتدا مقصد را انتخاب کن. "+
      "هیچ فرمانی به چت یا سرویس خارجی بدون مسیر مجاز اجرا نمی‌شود.",13,false));
  }
}
