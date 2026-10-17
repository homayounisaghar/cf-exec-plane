package dev.capabilityfabric.personalagent;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.text.InputType;
import java.util.Locale;

/** Alpha5 purpose-built cockpit: input, durable queue, remote diagnostics. */
public final class MainActivity extends Activity {
  private LinearLayout root,content;
  private TextView status,queueInfo,diagInfo,connectionInfo,githubInfo;
  private EditText command,workTag;
  private long lastSeenWakeSequence=0L;
  private String lastText="";
  private int dp(float x){return (int)(getResources().getDisplayMetrics().density*x+.5f);}
  private Button button(String title,View.OnClickListener listener){
    Button b=new Button(this);b.setText(title);b.setTextSize(14);b.setAllCaps(false);
    b.setOnClickListener(listener);return b;
  }
  private TextView section(String text){
    TextView v=new TextView(this);v.setText(text);v.setTextSize(17);
    v.setTextColor(Color.rgb(28,48,64));v.setTypeface(null,Typeface.BOLD);
    v.setPadding(0,dp(13),0,dp(4));return v;
  }
  private TextView hint(String text){
    TextView v=new TextView(this);v.setText(text);v.setTextColor(Color.rgb(77,90,105));
    v.setTextSize(13);v.setPadding(0,dp(3),0,dp(7));return v;
  }
  private void twoButtons(String left,View.OnClickListener a,String right,View.OnClickListener b){
    LinearLayout row=new LinearLayout(this);row.setOrientation(LinearLayout.HORIZONTAL);
    content.addView(row);
    row.addView(button(left,a),new LinearLayout.LayoutParams(0,dp(49),1));
    row.addView(button(right,b),new LinearLayout.LayoutParams(0,dp(49),1));
  }
  @Override public void onCreate(Bundle state){
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.rgb(23,37,51));
    getWindow().setNavigationBarColor(Color.rgb(23,37,51));
    root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(246,248,251));
    root.setOnApplyWindowInsetsListener((v,insets)->{
      v.setPadding(dp(12),insets.getSystemWindowInsetTop()+dp(6),
         dp(12),insets.getSystemWindowInsetBottom()+dp(6));
      return insets;
    });
    setContentView(root);
    TextView title=section("Personal Agent OS · Alpha 7");
    title.setTextSize(21);title.setPadding(0,0,0,dp(1));root.addView(title);
    root.addView(hint("Voice → VPS · کارهای موازی و نتایج"));
    status=hint("در حال آماده‌سازی…");root.addView(status);
    ScrollView scroll=new ScrollView(this);
    scroll.setFillViewport(false);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
    content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(content);

    content.addView(section("ورودی فرمان"));
    twoButtons("Speak · گفتار",v->openVoice(true),
               "Wake · بیدارباش",v->openVoice(false));
    content.addView(hint("پاسخ هوش مصنوعی هنوز اجرا نمی‌شود؛ رسید VPS فقط ثبت فرمان است."));
    command=new EditText(this);
    command.setHint("فرمان را تایپ کن یا با میکروفون بگو");
    command.setTextSize(18);command.setMinLines(2);command.setGravity(48);
    content.addView(command);
    workTag=new EditText(this);workTag.setSingleLine(true);workTag.setTextSize(14);
    workTag.setHint("Work ID (اختیاری؛ مثال: apk-test)");
    workTag.setText(getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .getString(AgentOutbox.KEY_WORK,""));
    content.addView(workTag);
    twoButtons("ثبت فرمان در صف",v->queueTyped(),"نمایش کیبورد",v->focusEditor());

    content.addView(section("کارهای من و نتیجه‌ها"));
    content.addView(button("نمایش سه کار و انتخاب مقصد فرمان",v->
      startActivity(new Intent(this,WorkBoardActivity.class))));
    content.addView(hint("در این نسخه رسید دریافت با نتیجه اجرای کار متفاوت است."));

    content.addView(section("صف و اتصال"));
    connectionInfo=hint("");content.addView(connectionInfo);
    twoButtons("Sync now",v->syncAll(),"Queue / Works",v->fetchWorks());
    content.addView(button("Pair / اتصال دستگاه",v->pairDialog()));
    queueInfo=hint("");content.addView(queueInfo);

    content.addView(section("تله‌متری از راه دور"));
    content.addView(hint("فقط رخدادهای فنی، شمارنده‌ها و خطاهای دسته‌بندی‌شده؛ بدون متن فرمان، صدا، توکن یا چت."));
    diagInfo=hint("");content.addView(diagInfo);
    twoButtons("ارسال سیگنال تست",v->diagnosticPing(),
               "خواندن گزارش VPS",v->remoteReadback());
    twoButtons("روشن / خاموش گزارش",v->toggleDiagnostics(),
               "پاک‌کردن گزارش محلی",v->clearLocalDiagnostics());
    content.addView(hint("آخرین وضعیت VPS فقط هنگام اتصال به‌روز می‌شود. بدون اینترنت ممکن است قدیمی باشد."));

    content.addView(section("GitHub · ارتباط بدون VPN (آزمایشی)"));
    content.addView(hint("توکن فقط روی گوشی و در Android Keystore نگهداری می‌شود. ایجاد Issue به معنی تحویل VPS نیست."));
    githubInfo=hint("");
    content.addView(githubInfo);
    twoButtons("ثبت مجوز امن گوشی",v->configureGithub(),
               "ارسال تست GitHub",v->sendGithubDiagnostic());
    twoButtons("بررسی رسید امضاشده",v->pollGithubReceipt(),
               "خاموش / حذف مجوز",v->clearGithubCredential());
    content.addView(button("فعال/خاموش‌کردن پشتیبان خودکار فرمان‌ها",v->toggleGithubBackup()));
    content.addView(hint("ارسال شخصی فقط بعد از دریافت رسید امضاشده و تأیید جداگانهٔ خودت فعال می‌شود."));

    lastSeenWakeSequence=CommandInbox.latestSequence(this);
    refreshLocal();
    AgentTelemetry.note(this,"APP_START","APP","IDLE","NONE");
    status.setText("آماده · دستورها فقط ذخیره می‌شوند، نه اجرا.");
  }
  private void showStatus(String text){
    status.setText(text);
  }
  private void refreshLocal(){
    boolean connected=AgentTransport.paired(this);
    connectionInfo.setText("جفت‌شده: "+(connected?"بله":"خیر")+
      "  |  VPS: cf-onshape.duckdns.org");
    try(AgentOutbox out=new AgentOutbox(this)){
      queueInfo.setText("PENDING: "+out.count("PENDING")+
        "    ACKED: "+out.count("ACKED")+
        "\nACKED = ثبت پایدار در VPS، نه اجرای فرمان.");
    }catch(Exception e){queueInfo.setText("وضعیت صف موقتاً قابل خواندن نیست.");}
    try(AgentTelemetry t=new AgentTelemetry(this)){
      diagInfo.setText("تله‌متری: "+(AgentTelemetry.enabled(this)?"روشن":"متوقف")+
        "    در انتظار ارسال: "+t.count("PENDING")+
        "\nگزارش‌ها روی VPS حداکثر ۷ روز نگهداری می‌شوند.");
    }catch(Exception e){diagInfo.setText("وضعیت تله‌متری موقتاً نامشخص است.");}
    if(githubInfo!=null)githubInfo.setText(
      "GitHub: "+(GithubRelayVault.enabled(this)?"فعال":"خاموش")+
      "  |  رسید امضاشده: "+(GithubRelayVault.verified(this)?"تأیید شده":"هنوز تأیید نشده")+
      "  |  پشتیبان فرمان‌ها: "+(GithubRelayVault.backgroundAllowed(this)?"روشن":"خاموش"));
  }
  private boolean saveWork(){
    String w=workTag.getText().toString().trim();
    if(!w.isEmpty()&&!w.matches("[A-Za-z0-9_-]{1,100}")){
      showStatus("Work ID نامعتبر است. فقط حروف لاتین، عدد، خط تیره و زیرخط.");return false;
    }
    if(!getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
        .edit().putString(AgentOutbox.KEY_WORK,w).commit()){
      showStatus("ذخیرهٔ Work ID انجام نشد.");return false;
    }
    return true;
  }
  private void queueTyped(){
    if(!saveWork())return;
    String txt=command.getText().toString();
    String work=workTag.getText().toString().trim();
    try(AgentOutbox out=new AgentOutbox(this)){
      String id=out.enqueueManual(txt,work.isEmpty()?null:work);
      lastText=txt;
      AgentTelemetry.note(this,"QUEUE_CAPTURED","TYPE","PENDING","NONE");
      AgentSyncScheduler.schedule(this);
      showStatus("فرمان "+id.substring(0,8)+" در صف محلی ذخیره شد.");
      refreshLocal();
    }catch(Exception e){
      AgentTelemetry.note(this,"QUEUE_ERROR","TYPE","ERROR","STORE");
      showStatus("فرمان ثبت نشد؛ متن و شناسهٔ کار را بررسی کن.");
    }
  }
  private void focusEditor(){
    command.requestFocus();
    command.postDelayed(()->{
      InputMethodManager imm=(InputMethodManager)getSystemService(INPUT_METHOD_SERVICE);
      if(imm!=null)imm.showSoftInput(command,InputMethodManager.SHOW_IMPLICIT);
    },120);
  }
  private void openVoice(boolean dictation){
    if(!saveWork())return;
    if(dictation && command!=null)lastText=command.getText().toString();
    AgentTelemetry.note(this,dictation?"SPEAK_OPEN":"WAKE_OPEN",
      dictation?"SPEAK":"WAKE","AUTH","NONE");
    Intent i=new Intent(this,WakeActivity.class);
    if(dictation)i.putExtra(WakeActivity.EXTRA_DICTATION_MODE,true);
    startActivity(i);
  }
  @Override protected void onResume(){
    super.onResume();
    long next=CommandInbox.latestSequence(this);
    if(command!=null && next>lastSeenWakeSequence){
      lastSeenWakeSequence=next;
      String value=CommandInbox.latest(this);
      if(value!=null){lastText=value;command.setText(value);}
      showStatus("فرمان صوتی در صف پایدار ذخیره شد. وضعیت VPS را در Queue ببین.");
    }
    if(workTag!=null)workTag.setText(getSharedPreferences(AgentOutbox.PREF_WORK,MODE_PRIVATE)
      .getString(AgentOutbox.KEY_WORK,""));
    if(queueInfo!=null)refreshLocal();
    AgentTelemetry.note(this,"APP_RESUME","APP","IDLE","NONE");
  }
  @Override protected void onPause(){
    AgentTelemetry.note(this,"APP_PAUSE","APP","IDLE","NONE");
    super.onPause();
  }
  private void syncAll(){
    showStatus("در حال دریافت رسید VPS و ارسال گزارش‌های فنی...");
    new Thread(()->{
      AgentTransport.Report q=AgentTransport.syncOnce(this,50);
      AgentTransport.TelemetryReport t=AgentTransport.syncTelemetry(this,30);
      runOnUiThread(()->{
        refreshLocal();
        showStatus("فرمان: "+q.acknowledged+" رسید جدید / "+q.remaining+
          " منتظر · گزارش: "+t.acknowledged+" ارسال / "+t.remaining+
          " منتظر · "+t.detail);
      });
    },"alpha5-sync").start();
  }
  private void fetchWorks(){
    showStatus("در حال دریافت وضعیت صف کارها از VPS...");
    new Thread(()->{
      String summary=AgentTransport.workSummary(this);
      runOnUiThread(()->{
        refreshLocal();
        showStatus("VPS work summary: "+summary+
          "\nتمام کارهای دریافتی فعلاً QUEUED هستند، نه اجراشده.");
      });
    },"alpha5-work-read").start();
  }
  private void diagnosticPing(){
    if(!AgentTelemetry.enabled(this)){
      showStatus("برای تست، ابتدا گزارش‌دهی را روشن کن.");return;
    }
    AgentTelemetry.note(this,"DIAGNOSTIC_PING","MANUAL","IDLE","NONE");
    showStatus("سیگنال فنی در صف محلی ثبت شد؛ در حال ارسال...");
    new Thread(()->{
      AgentTransport.TelemetryReport r=AgentTransport.syncTelemetry(this,30);
      runOnUiThread(()->{
        refreshLocal();
        showStatus("تست جدید تله‌متری: "+r.acknowledged+" ثبت در VPS، "+
          r.remaining+" در صف. "+r.detail);
      });
    },"alpha5-diagnostic-ping").start();
  }
  private void remoteReadback(){
    showStatus("در حال خواندن آخرین رخداد از VPS...");
    new Thread(()->{
      String text=AgentTransport.diagnosticSummary(this);
      runOnUiThread(()->{
        refreshLocal();
        showStatus(text);
      });
    },"alpha5-remote-readback").start();
  }
  private void toggleDiagnostics(){
    boolean enable=!AgentTelemetry.enabled(this);
    boolean ok=AgentTelemetry.setEnabled(this,enable);
    refreshLocal();
    showStatus(ok ? (enable?
      "گزارش‌دهی فنی فعال شد (فقط فراداده).":
      "گزارش‌دهی متوقف و صف محلی گزارش‌ها پاک شد."):
      "تغییر تنظیمات گزارش‌دهی انجام نشد.");
  }
  private void clearLocalDiagnostics(){
    new AlertDialog.Builder(this)
      .setTitle("پاک‌کردن گزارش‌های محلی")
      .setMessage("فقط رخدادهای فنی گوشی پاک می‌شوند. گزارش‌هایی که قبلاً به VPS رسیده‌اند تا پایان مهلت نگهداری سرور باقی می‌مانند.")
      .setPositiveButton("پاک کن",(dialog,which)->{
        try(AgentTelemetry t=new AgentTelemetry(this)){
          t.clearLocal();refreshLocal();showStatus("گزارش‌های محلی پاک شدند.");
        }catch(Exception e){showStatus("خطا در پاک‌کردن گزارش‌های محلی.");}
      })
      .setNegativeButton("انصراف",null).show();
  }
  private void configureGithub(){
    EditText field=new EditText(this);
    field.setSingleLine(true);
    field.setHint("github_pat_...");
    field.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
    new AlertDialog.Builder(this)
      .setTitle("مجوز جداگانهٔ گوشی برای صندوق خصوصی")
      .setMessage("فقط توکن Fine-grained محدود به Issues این مخزن. این توکن هرگز به ChatGPT، متن Issue یا APK فرستاده نمی‌شود. مجوز VPS را دوباره در گوشی استفاده نکن.")
      .setView(field)
      .setPositiveButton("اعتبارسنجی و ذخیره",(dialog,which)->{
        final String value=field.getText().toString().trim();
        field.setText("");
        showStatus("در حال بررسی دسترسی خصوصی GitHub...");
        new Thread(()->{
          String result=GithubRelayTransport.validateNewToken(this,value);
          if("PRIVATE_MAILBOX_AUTHENTICATED".equals(result)){
            try{
              GithubRelayVault.store(this,value);
              if(!GithubRelayVault.setEnabled(this,true))result="ENABLE_FAILED";
              else result="مجوز گوشی در Keystore ثبت شد. حالا تست GitHub را بزن.";
            }catch(Exception e){result="ذخیرهٔ امن انجام نشد.";}
          }
          final String message=result;
          runOnUiThread(()->{refreshLocal();showStatus(message);});
        },"alpha6-github-token-setup").start();
      }).setNegativeButton("انصراف",null).show();
  }
  private void sendGithubDiagnostic(){
    if(!GithubRelayVault.enabled(this)){
      showStatus("اول مجوز خصوصی گوشی را ثبت کن.");return;
    }
    if(!AgentTelemetry.enabled(this)){
      showStatus("برای تست، گزارش‌دهی فنی باید روشن باشد.");return;
    }
    AgentTelemetry.note(this,"DIAGNOSTIC_PING","MANUAL","IDLE","NONE");
    showStatus("در حال رمزگذاری و ثبت آزمایشی در GitHub...");
    new Thread(()->{
      GithubRelayTransport.Report result=GithubRelayTransport.sync(this,true);
      runOnUiThread(()->{
        refreshLocal();
        showStatus("GitHub: "+result.posted+" Issue جدید، "+
          result.acked+" رسید VPS، "+result.pending+" منتظر. "+result.detail+
          "\nتنها رسید امضاشدهٔ سرور فرمان را ACK می‌کند.");
      });
    },"alpha6-github-test").start();
  }
  private void pollGithubReceipt(){
    if(!GithubRelayVault.enabled(this)){showStatus("ابتدا مجوز گوشی را ثبت کن.");return;}
    showStatus("در حال بررسی رسید امضاشدهٔ VPS در GitHub...");
    new Thread(()->{
      GithubRelayTransport.Report result=GithubRelayTransport.sync(this,true);
      runOnUiThread(()->{
        refreshLocal();
        showStatus("GitHub: "+result.acked+" رسید معتبر VPS، "+
          result.pending+" مورد منتظر. "+result.detail);
      });
    },"alpha6-github-receipt").start();
  }
  private void toggleGithubBackup(){
    if(GithubRelayVault.backgroundAllowed(this)){
      boolean ok=GithubRelayVault.setBackgroundAllowed(this,false);
      refreshLocal();
      showStatus(ok?"پشتیبان خودکار فرمان‌ها خاموش شد. صف اصلی محفوظ است.":
        "خاموش‌کردن پشتیبان ناموفق بود.");
      return;
    }
    if(!GithubRelayVault.verified(this)){
      showStatus("ابتدا یک DIAGNOSTIC_PING بفرست و رسید امضاشدهٔ واقعی VPS را بگیر.");
      return;
    }
    new AlertDialog.Builder(this)
      .setTitle("اجازهٔ ارسال خودکار فرمان‌ها")
      .setMessage("وقتی VPS مستقیم در دسترس نباشد، فرمان‌های صف و گزارش‌های فنی با RSA/AES رمزگذاری و از GitHub Issues خصوصی عبور می‌کنند. GitHub زمان و اندازهٔ پیام‌ها را می‌بیند، نه متن آن‌ها را. هیچ فرمانی قبل از رسید امضاشدهٔ VPS، ACK نمی‌شود. سقف ارسال روزانه محدود است. آیا تأیید می‌کنی؟")
      .setPositiveButton("تأیید و روشن کن",(d,w)->{
        boolean ok=GithubRelayVault.setBackgroundAllowed(this,true);
        refreshLocal();
        showStatus(ok?"پشتیبان خودکار با تأیید مالک روشن شد.":"روشن‌کردن پشتیبان ناموفق بود.");
        if(ok)AgentSyncScheduler.schedule(this);
      }).setNegativeButton("انصراف",null).show();
  }
  private void clearGithubCredential(){
    new AlertDialog.Builder(this).setTitle("حذف مجوز GitHub از گوشی")
      .setMessage("توکن ذخیره‌شده حذف و مسیر پشتیبان خاموش می‌شود. Issueهای رمزگذاری‌شدهٔ قبلی در مخزن باقی می‌مانند؛ برای لغو کامل مجوز، توکن را در تنظیمات GitHub نیز Revoke کن.")
      .setPositiveButton("خاموش و حذف کن",(d,w)->{
        try{GithubRelayVault.clear(this);refreshLocal();
          showStatus("مجوز گوشی حذف و اتصال GitHub خاموش شد.");
        }catch(Exception e){showStatus("خطا در حذف مجوز گوشی.");}
      }).setNegativeButton("انصراف",null).show();
  }
  private void pairDialog(){
    EditText field=new EditText(this);
    field.setSingleLine(true);field.setHint("کد یک‌بارمصرف ۱۶ کاراکتری");
    new AlertDialog.Builder(this)
      .setTitle("اتصال امن به VPS")
      .setMessage("اگر دستگاه قبلاً جفت شده، نیازی به اتصال مجدد نیست. کد را فقط از مالک سرور دریافت کن.")
      .setView(field)
      .setPositiveButton("اتصال",(dlg,which)->{
        final String code=field.getText().toString().trim()
          .replace(" ","").toUpperCase(Locale.ROOT);
        showStatus("در حال جفت‌سازی...");
        new Thread(()->{
          try{
            String prefix=AgentTransport.pair(this,code);
            runOnUiThread(()->{
              refreshLocal();showStatus("دستگاه متصل شد: "+prefix);
            });
          }catch(Exception e){
            runOnUiThread(()->showStatus("جفت‌سازی ناموفق: "+TelemetryContractV1.exceptionCode(e)));
          }
        },"alpha5-pair").start();
      })
      .setNegativeButton("انصراف",null).show();
  }
}
