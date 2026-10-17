package dev.capabilityfabric.personalagent;
import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;

/** Transport cannot execute commands. It only obtains durable ingress receipts over verified TLS. */
public final class AgentTransport {
  public static final String BASE="https://cf-onshape.duckdns.org/agentos-alpha4";
  private static final String PREFS="agentos_device_pair_v1";
  private static final String TOKEN="device_token";
  private AgentTransport(){}
  public static final class Report{
    public final int acknowledged;
    public final int remaining;
    public final String detail;
    Report(int acknowledged,int remaining,String detail){
      this.acknowledged=acknowledged;this.remaining=remaining;this.detail=detail;
    }
  }
  public static final class TelemetryReport {
    public final int acknowledged, remaining;
    public final String detail;
    TelemetryReport(int acknowledged,int remaining,String detail) {
      this.acknowledged=acknowledged;this.remaining=remaining;this.detail=detail;
    }
  }
  public static boolean paired(Context ctx){
    return !ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(TOKEN,"").isEmpty();
  }
  private static String token(Context ctx){
    return ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(TOKEN,"");
  }
  static String tokenForEncryptedRelay(Context ctx){
    return token(ctx);
  }
  private static final class Reply {
    final int code;final JSONObject body;
    Reply(int code,JSONObject body){this.code=code;this.body=body;}
  }
  private static Reply request(String route,JSONObject data,String bearer) throws Exception{
    if(!route.startsWith("/")||route.contains("?")||route.contains("#")||route.contains(".."))
      throw new IllegalArgumentException("BAD_ROUTE");
    URL u=new URL(BASE+route);
    if(!"https".equals(u.getProtocol())||!"cf-onshape.duckdns.org".equals(u.getHost())||u.getPort()!=-1)
      throw new IllegalArgumentException("TLS_ENDPOINT_NOT_PINNED");
    HttpsURLConnection conn=(HttpsURLConnection)u.openConnection();
    conn.setInstanceFollowRedirects(false);
    conn.setConnectTimeout(8000);conn.setReadTimeout(12000);conn.setUseCaches(false);
    conn.setRequestProperty("Accept","application/json");
    if(bearer!=null)conn.setRequestProperty("Authorization","Bearer "+bearer);
    if(data!=null){
      conn.setRequestMethod("POST");
      conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type","application/json; charset=utf-8");
      byte[] bytes=data.toString().getBytes(StandardCharsets.UTF_8);
      if(bytes.length>16000)throw new IllegalArgumentException("MESSAGE_TOO_LARGE");
      conn.setFixedLengthStreamingMode(bytes.length);
      try(OutputStream os=conn.getOutputStream()){os.write(bytes);}
    }else conn.setRequestMethod("GET");
    try{
      int code=conn.getResponseCode();
      if(code>=300&&code<400)throw new IllegalStateException("REDIRECT_NOT_ACCEPTED");
      InputStream in=code>=400?conn.getErrorStream():conn.getInputStream();
      if(in==null)throw new IllegalStateException("EMPTY_RESPONSE");
      ByteArrayOutputStream b=new ByteArrayOutputStream();
      try(InputStream stream=in){
        byte[] chunk=new byte[2048];int n;
        while((n=stream.read(chunk))!=-1){
          if(b.size()+n>16000)throw new IllegalStateException("RESPONSE_TOO_LARGE");
          b.write(chunk,0,n);
        }
      }
      return new Reply(code,new JSONObject(new String(b.toByteArray(),StandardCharsets.UTF_8)));
    }finally{conn.disconnect();}
  }
  public static String pair(Context ctx,String code) throws Exception{
    if(code==null||!code.matches("[A-Z2-9]{16}"))
      throw new IllegalArgumentException("PAIR_CODE_MUST_BE_16_CHARACTERS");
    JSONObject payload=new JSONObject();payload.put("pairing_code",code);
    Reply r=request("/v2/pair",payload,null);
    if(r.code!=201||!"cf.agentos.pair.v1".equals(r.body.optString("schema")))
      throw new IllegalStateException("PAIR_DENIED_HTTP_"+r.code);
    String deviceToken=r.body.optString("device_token","");
    String deviceId=r.body.optString("device_id","");
    if(deviceToken.length()<32||deviceId.length()!=32)
      throw new IllegalStateException("INVALID_PAIR_REPLY");
    SharedPreferences prefs=ctx.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    if(!prefs.edit().putString(TOKEN,deviceToken).putString("device_id",deviceId).commit())
      throw new IllegalStateException("DEVICE_TOKEN_SAVE_FAILED");
    AgentTelemetry.note(ctx,"PAIR_SUCCESS","APP","IDLE","NONE");
    AgentSyncScheduler.schedule(ctx);
    return deviceId.substring(0,8);
  }
  public static Report syncOnce(Context ctx,int max){
    if(!paired(ctx))return new Report(0,countPending(ctx),"PAIRING_REQUIRED");
    int succeeded=0;
    try(AgentOutbox queue=new AgentOutbox(ctx)){
      List<JSONObject> batch=queue.pending(Math.max(1,Math.min(50,max)));
      if(!batch.isEmpty())
        AgentTelemetry.note(ctx,"SYNC_BEGIN","JOB","PENDING","NONE");
      for(JSONObject command:batch){
        Reply r=request("/v2/commands",command,token(ctx));
        if(r.code!=200&&r.code!=201){
          AgentTelemetry.note(ctx,"SYNC_ERROR","JOB","ERROR","HTTP");
          return new Report(succeeded,queue.count("PENDING"),"SERVER_HTTP_"+r.code);
        }
        String id=command.getString("command_id");
        queue.acknowledge(r.body,id);
        succeeded++;
        AgentTelemetry.note(ctx,"SYNC_ACK","JOB","ACKED","NONE");
      }
      int remain=queue.count("PENDING");
      return new Report(succeeded,remain,remain==0?"DURABLY_QUEUED":"MORE_PENDING");
    }catch(Exception e){
      AgentTelemetry.note(ctx,"SYNC_ERROR","JOB","ERROR",TelemetryContractV1.exceptionCode(e));
      return new Report(succeeded,countPending(ctx), "DELIVERY_PENDING_"+e.getClass().getSimpleName());
    }
  }
  public static TelemetryReport syncTelemetry(Context ctx,int max){
    if(!AgentTelemetry.enabled(ctx))return new TelemetryReport(0,0,"DIAGNOSTICS_PAUSED");
    if(!paired(ctx))return new TelemetryReport(0,telemetryPending(ctx),"PAIRING_REQUIRED");
    int sent=0;
    try(AgentTelemetry queue=new AgentTelemetry(ctx)){
      List<JSONObject> events=queue.pending(Math.max(1,Math.min(30,max)));
      for(JSONObject event:events){
        Reply r=request("/v3/telemetry",event,token(ctx));
        if(r.code!=200 && r.code!=201)
          return new TelemetryReport(sent,queue.count("PENDING"),"HTTP_"+r.code);
        queue.acknowledge(r.body,event.getString("event_id"),event.getLong("seq"));
        sent++;
      }
      int remain=queue.count("PENDING");
      return new TelemetryReport(sent,remain,remain==0?"TELEMETRY_RECORDED":"MORE_PENDING");
    }catch(Exception e){
      return new TelemetryReport(sent,telemetryPending(ctx),
        "TELEMETRY_PENDING_"+TelemetryContractV1.exceptionCode(e));
    }
  }
  public static int telemetryPending(Context ctx){
    if(!AgentTelemetry.enabled(ctx))return 0;
    try(AgentTelemetry q=new AgentTelemetry(ctx)){return q.count("PENDING");}
    catch(Exception ignored){return -1;}
  }
  public static String diagnosticSummary(Context ctx){
    if(!AgentTelemetry.enabled(ctx))return "DIAGNOSTICS_PAUSED";
    if(!paired(ctx))return "PAIRING_REQUIRED";
    try{
      Reply r=request("/v3/telemetry/summary",null,token(ctx));
      if(r.code!=200)return "SERVER_HTTP_"+r.code;
      JSONObject body=r.body;
      String last=(body.optJSONObject("latest")==null)?"none":
        body.optJSONObject("latest").optString("event_type","unknown");
      return "Remote events: "+body.optInt("event_count",0)+
        "\nLast event: "+last+
        "\nLast receipt time (ms UTC): "+body.optLong("last_seen_ms",0)+
        "\nStale (>15 min): "+body.optBoolean("stale",true)+
        "\nServer readback: recorded metadata only";
    }catch(Exception e){
      return "STATUS_UNAVAILABLE_"+TelemetryContractV1.exceptionCode(e);
    }
  }
  public static int countPending(Context ctx){
    try(AgentOutbox queue=new AgentOutbox(ctx)){return queue.count("PENDING");}
    catch(Exception e){return -1;}
  }
  /** Read-only task-board endpoint. Legacy fallback reports only queued receipts. */
  public static JSONObject workBoard(Context ctx) throws Exception {
    if(!paired(ctx))throw new IllegalStateException("PAIRING_REQUIRED");
    Reply v4=request("/v4/board",null,token(ctx));
    if(v4.code==200 && "cf.agentos.work-board.v8".equals(v4.body.optString("schema")))
      return v4.body;
    if(v4.code!=404)throw new IllegalStateException("V4_HTTP_"+v4.code);
    Reply legacy=request("/v2/works",null,token(ctx));
    if(legacy.code!=200)throw new IllegalStateException("LEGACY_HTTP_"+legacy.code);
    JSONObject fallback=new JSONObject();
    fallback.put("schema","cf.agentos.work-board.v8");
    fallback.put("mode","INGRESS_ONLY");
    fallback.put("works",legacy.body.optJSONArray("works"));
    return fallback;
  }
  public static String workSummary(Context ctx){
    if(!paired(ctx))return "PAIRING_REQUIRED";
    try{
      Reply r=request("/v2/works",null,token(ctx));
      if(r.code!=200)return "SERVER_HTTP_"+r.code;
      return r.body.toString();
    }catch(Exception e){return "STATUS_UNAVAILABLE_"+e.getClass().getSimpleName();}
  }
}
