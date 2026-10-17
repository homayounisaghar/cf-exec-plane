package dev.capabilityfabric.personalagent;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;

/** Opt-in, low-volume encrypted GitHub Issues fallback. Never confuses Issue POST with VPS ACK. */
public final class GithubRelayTransport {
  private static final String HOST="api.github.com";
  private static final String REPO="homayounisaghar/personal-agent-os-mailbox";
  private static final String ROOT="/repos/"+REPO;
  private static final String BUDGET_PREFS="agentos_github_api_budget_v1";
  private static final int MAX_CALLS_DAY=180,MAX_POST_DAY=20;
  private static final long MIN_POLL_MS=5*60*1000L;
  private GithubRelayTransport(){}
  public static final class Report {
    public final int posted,acked,pending;
    public final String detail;
    Report(int posted,int acked,int pending,String detail){
      this.posted=posted;this.acked=acked;this.pending=pending;this.detail=detail;
    }
  }
  private static String asset(Context c,String file)throws Exception{
    try(InputStream in=c.getAssets().open(file)){
      ByteArrayOutputStream out=new ByteArrayOutputStream();
      byte[] data=new byte[2048];int count;
      while((count=in.read(data))!=-1){
        if(out.size()+count>1500)throw new IllegalStateException("KEY_ASSET_TOO_LARGE");
        out.write(data,0,count);
      }
      return new String(out.toByteArray(),StandardCharsets.US_ASCII);
    }
  }
  private static synchronized void budget(Context c,boolean post)throws Exception{
    SharedPreferences p=c.getSharedPreferences(BUDGET_PREFS,Context.MODE_PRIVATE);
    long utcDay=System.currentTimeMillis()/86400000L;
    long was=p.getLong("day",-1L);
    int count=was==utcDay?p.getInt("calls",0):0;
    int sends=was==utcDay?p.getInt("posts",0):0;
    if(count>=MAX_CALLS_DAY||(post&&sends>=MAX_POST_DAY))
      throw new IllegalStateException("GITHUB_FREE_BUDGET_LIMIT");
    if(!p.edit().putLong("day",utcDay).putInt("calls",count+1)
      .putInt("posts",sends+(post?1:0)).commit())
      throw new IllegalStateException("BUDGET_SAVE_FAILED");
  }
  private static final class Reply {
    final int code;final Object payload;
    Reply(int code,Object payload){this.code=code;this.payload=payload;}
    JSONObject object()throws Exception{
      if(!(payload instanceof JSONObject))throw new IllegalStateException("GITHUB_OBJECT_EXPECTED");
      return (JSONObject)payload;
    }
    JSONArray array()throws Exception{
      if(!(payload instanceof JSONArray))throw new IllegalStateException("GITHUB_ARRAY_EXPECTED");
      return (JSONArray)payload;
    }
  }
  private static Reply request(Context c,String pat,String method,String route,JSONObject body)throws Exception{
    if(!route.startsWith(ROOT) || route.contains("..")||route.contains("#")||
       !("GET".equals(method)||"POST".equals(method)))
      throw new IllegalArgumentException("GITHUB_ROUTE_DENIED");
    URL url=new URL("https://"+HOST+route);
    if(!"https".equals(url.getProtocol())||!HOST.equals(url.getHost())||url.getPort()!=-1)
      throw new IllegalArgumentException("GITHUB_TLS_HOST_MISMATCH");
    budget(c,"POST".equals(method));
    HttpsURLConnection conn=(HttpsURLConnection)url.openConnection();
    conn.setInstanceFollowRedirects(false);
    conn.setConnectTimeout(9000);conn.setReadTimeout(12000);
    conn.setUseCaches(false);conn.setRequestMethod(method);
    conn.setRequestProperty("Accept","application/vnd.github+json");
    conn.setRequestProperty("Authorization","Bearer "+pat);
    conn.setRequestProperty("X-GitHub-Api-Version","2022-11-28");
    conn.setRequestProperty("User-Agent","personal-agent-os-alpha6");
    byte[] bytes=body==null?null:body.toString().getBytes(StandardCharsets.UTF_8);
    if(bytes!=null){
      if(bytes.length>16000)throw new IllegalArgumentException("GITHUB_REQUEST_TOO_LARGE");
      conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type","application/json; charset=utf-8");
      conn.setFixedLengthStreamingMode(bytes.length);
    }
    try{
      if(bytes!=null)try(OutputStream os=conn.getOutputStream()){os.write(bytes);}
      int status=conn.getResponseCode();
      if(status>=300&&status<400)throw new IllegalStateException("GITHUB_REDIRECT_REFUSED");
      InputStream stream=status>=400?conn.getErrorStream():conn.getInputStream();
      if(status!=200&&status!=201)throw new IllegalStateException("GITHUB_HTTP_"+status);
      if(stream==null)throw new IllegalStateException("GITHUB_EMPTY_RESPONSE");
      ByteArrayOutputStream data=new ByteArrayOutputStream();
      try(InputStream is=stream){
        byte[] block=new byte[4096];int n;
        while((n=is.read(block))!=-1){
          if(data.size()+n>180000)throw new IllegalStateException("GITHUB_RESPONSE_TOO_LARGE");
          data.write(block,0,n);
        }
      }
      String raw=new String(data.toByteArray(),StandardCharsets.UTF_8).trim();
      if(raw.startsWith("{"))return new Reply(status,new JSONObject(raw));
      if(raw.startsWith("["))return new Reply(status,new JSONArray(raw));
      throw new IllegalStateException("GITHUB_JSON_EXPECTED");
    }finally{conn.disconnect();}
  }
  public static String validateNewToken(Context c,String candidate){
    try{
      if(candidate==null||!candidate.matches("github_pat_[A-Za-z0-9_]{35,290}"))
        return "INVALID_FINE_GRAINED_TOKEN";
      JSONObject repo=request(c,candidate,"GET",ROOT,null).object();
      if(!repo.optBoolean("private",false)||!repo.optBoolean("has_issues",false)||
         !REPO.equals(repo.optString("full_name","")))
        return "PRIVATE_MAILBOX_MISMATCH";
      request(c,candidate,"GET",ROOT+"/issues?state=open&per_page=1",null).array();
      return "PRIVATE_MAILBOX_AUTHENTICATED";
    }catch(Exception e){
      return "GITHUB_ACCESS_UNAVAILABLE_"+TelemetryContractV1.exceptionCode(e);
    }
  }
  private static String packetId(JSONObject source,String kind)throws Exception{
    String value="COMMAND".equals(kind)?source.getString("command_id").replace("-",""):
      source.getString("event_id");
    if(!value.matches("[0-9a-f]{32}"))throw new IllegalArgumentException("PACKET_ID_MUST_BE_UUID");
    return value;
  }
  private static GithubRelayStore.Packet staged(Context c,GithubRelayStore db,
      JSONObject payload,String kind)throws Exception{
    String packetId=packetId(payload,kind);
    GithubRelayStore.Packet prior=db.load(packetId);
    if(prior!=null)return prior;
    String route="COMMAND".equals(kind)?"/v2/commands":"/v3/telemetry";
    String scopedPairToken=AgentTransport.tokenForEncryptedRelay(c);
    if(scopedPairToken.length()<30)throw new IllegalStateException("PAIRING_REQUIRED");
    JSONObject inner=new JSONObject();
    inner.put("schema",GithubRelayCrypto.PAYLOAD_SCHEMA);
    inner.put("packet_id",packetId);
    inner.put("route",route);
    inner.put("token",scopedPairToken);
    inner.put("payload",payload);
    GithubRelayCrypto.Sealed encrypted=GithubRelayCrypto.seal(
      asset(c,"github_relay_encrypt.pem"),packetId,
      GithubRelayJson.canonical(inner).getBytes(StandardCharsets.UTF_8));
    JSONObject env=new JSONObject();
    env.put("schema",GithubRelayCrypto.ENVELOPE_SCHEMA);
    env.put("packet_id",packetId);
    env.put("kid",GithubRelayCrypto.KEY_ID);
    env.put("alg",GithubRelayCrypto.ALGORITHM);
    env.put("wrapped_key",encrypted.wrappedKey);
    env.put("nonce",encrypted.nonce);
    env.put("ciphertext",encrypted.ciphertext);
    return db.capture(packetId,GithubRelayJson.canonical(env),kind);
  }
  private static long findPriorIssue(Context c,String pat,String id)throws Exception{
    JSONArray issues=request(c,pat,"GET",
      ROOT+"/issues?state=all&per_page=100&sort=created&direction=desc",null).array();
    String title="agentos-envelope-v1:"+id;
    for(int i=0;i<issues.length();i++){
      JSONObject issue=issues.optJSONObject(i);
      if(issue==null||issue.has("pull_request"))continue;
      if(title.equals(issue.optString("title",""))&&
         "homayounisaghar".equalsIgnoreCase(issue.optJSONObject("user")==null?""
           :issue.optJSONObject("user").optString("login",""))){
        return issue.optLong("number",0);
      }
    }
    return 0;
  }
  private static long submit(Context c,String pat,GithubRelayStore db,
      GithubRelayStore.Packet p)throws Exception{
    if(p.issueNumber>0)return p.issueNumber;
    long existing=findPriorIssue(c,pat,p.id);
    if(existing>0){db.markIssued(p.id,existing);return existing;}
    JSONObject create=new JSONObject();
    create.put("title","agentos-envelope-v1:"+p.id);
    create.put("body",p.body);
    JSONObject result=request(c,pat,"POST",ROOT+"/issues",create).object();
    long num=result.optLong("number",-1);
    if(num<1||!("agentos-envelope-v1:"+p.id).equals(result.optString("title","")))
      throw new IllegalStateException("GITHUB_ISSUE_CREATE_REPLY_INVALID");
    db.markIssued(p.id,num);
    return num;
  }
  private static boolean acceptSigned(Context c,GithubRelayStore db,GithubRelayStore.Packet p,
      long issue,JSONObject original)throws Exception{
    JSONArray comments=request(c,GithubRelayVault.load(c),"GET",
        ROOT+"/issues/"+issue+"/comments?per_page=100",null).array();
    for(int i=0;i<comments.length();i++){
      JSONObject comment=comments.optJSONObject(i);
      if(comment==null)continue;
      String text=comment.optString("body","");
      if(text.length()<50||text.length()>9000)continue;
      JSONObject signed;
      try{signed=new JSONObject(text);}catch(Exception ignored){continue;}
      if(!"RS256".equals(signed.optString("algorithm","")))continue;
      JSONObject inner=signed.optJSONObject("body");
      if(inner==null || inner.length()!=5 ||
         !GithubRelayCrypto.RECEIPT_SCHEMA.equals(inner.optString("schema","")) ||
         !p.id.equals(inner.optString("packet_id","")))continue;
      boolean signature=GithubRelayCrypto.validSignature(
        asset(c,"github_relay_sign.pem"),
        GithubRelayJson.canonical(inner).getBytes(StandardCharsets.UTF_8),
        signed.optString("signature",""));
      if(!signature)continue;
      int code=inner.optInt("status_code",0);
      if(code!=200&&code!=201)
        throw new IllegalStateException("VPS_SIGNED_REJECTION_"+code);
      JSONObject receipt=inner.optJSONObject("receipt");
      if(receipt==null)throw new IllegalStateException("SIGNED_RECEIPT_MISSING");
      if("COMMAND".equals(p.kind)){
        try(AgentOutbox out=new AgentOutbox(c)){
          // Existing durable outbox checks command ID, content digest, work_id,
          // receipt ID, QUEUED state and executed=false.
          String originalId=original.getString("command_id");
          if(!originalId.replace("-","").equals(p.id))throw new IllegalStateException("COMMAND_ID_CHANGED");
          out.acknowledge(receipt,originalId);
        }
      }else{
        if(!original.getString("event_id").equals(p.id))throw new IllegalStateException("EVENT_ID_CHANGED");
        try(AgentTelemetry telemetry=new AgentTelemetry(c)){
          telemetry.acknowledge(receipt,p.id,original.getLong("seq"));
        }
        if("DIAGNOSTIC_PING".equals(original.optString("event_type","")))
          GithubRelayVault.setVerified(c);
      }
      db.forget(p.id);return true;
    }
    db.markChecked(p.id);
    return false;
  }
  private static final class Counter {
    int issued=0,ack=0,waiting=0;
  }
  private static void process(Context c,String pat,GithubRelayStore db,
     JSONObject payload,String kind,boolean force,Counter counter)throws Exception{
    GithubRelayStore.Packet p=staged(c,db,payload,kind);
    if(p.issueNumber==0){
      submit(c,pat,db,p);
      counter.issued++;
      p=db.load(p.id);
    }
    if(p==null)throw new IllegalStateException("STAGED_PACKET_MISSING");
    if(!force&&System.currentTimeMillis()-p.lastCheckedMs<MIN_POLL_MS){
      counter.waiting++;return;
    }
    if(acceptSigned(c,db,p,p.issueNumber,payload))counter.ack++;
    else counter.waiting++;
  }
  public static Report sync(Context ctx,boolean force){
    if(!GithubRelayVault.enabled(ctx))return new Report(0,0,0,"GITHUB_DISABLED");
    if(!AgentTransport.paired(ctx))return new Report(0,0,0,"PAIRING_REQUIRED");
    Counter total=new Counter();
    try{
      String pat=GithubRelayVault.load(ctx);
      try(GithubRelayStore db=new GithubRelayStore(ctx);
          AgentTelemetry telemetry=new AgentTelemetry(ctx);
          AgentOutbox out=new AgentOutbox(ctx)){
        // Before first signed phone test, never post personal commands.
        List<JSONObject> events=telemetry.pending(30);
        int limit=GithubRelayVault.backgroundAllowed(ctx)?2:1;
        int added=0;
        for(int i=events.size()-1;i>=0 && added<limit;i--){
          JSONObject event=events.get(i);
          if(!GithubRelayVault.backgroundAllowed(ctx)&&
             !"DIAGNOSTIC_PING".equals(event.optString("event_type","")))continue;
          process(ctx,pat,db,event,"TELEMETRY",force,total);
          added++;
        }
        if(GithubRelayVault.backgroundAllowed(ctx)){
          List<JSONObject> commands=out.pending(2);
          for(JSONObject command:commands)
            process(ctx,pat,db,command,"COMMAND",force,total);
        }
      }
      return new Report(total.issued,total.ack,total.waiting,
        total.waiting>0?"GITHUB_ISSUE_POSTED_WAIT_SIGNED_VPS_RECEIPT":"GITHUB_NO_PENDING");
    }catch(Exception e){
      String code=TelemetryContractV1.exceptionCode(e);
      String message=e.getMessage()==null?"":e.getMessage();
      // Only predefined machine codes may reach the UI. Never show exception
      // messages, GitHub response bodies, credentials or decrypted payloads.
      if(message.matches("GITHUB_HTTP_(401|403|404|422|429|500|502|503)"))
        code=message;
      else if("GITHUB_FREE_BUDGET_LIMIT".equals(message))
        code="DAILY_FREE_LIMIT";
      else if(message.matches("VPS_SIGNED_REJECTION_(400|401|409)"))
        code=message;
      return new Report(total.issued,total.ack,total.waiting,"GITHUB_PENDING_"+code);
    }
  }
}
