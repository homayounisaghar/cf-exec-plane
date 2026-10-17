package dev.capabilityfabric.personalagent;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Crash-durable, bounded, content-free metadata queue; separate from command outbox. */
public final class AgentTelemetry extends SQLiteOpenHelper {
  public static final String PREFS="agentos_diag_preferences";
  private static final String KEY_ENABLED="metadata_enabled";
  private static final String DB="agentos-diagnostics-v1.sqlite";
  private static final int MAX_LOCAL=512;
  public AgentTelemetry(Context c){super(c,DB,null,1);}
  @Override public void onCreate(SQLiteDatabase db){
    db.execSQL("CREATE TABLE events ("+
      "seq INTEGER PRIMARY KEY AUTOINCREMENT,"+
      "event_id TEXT NOT NULL UNIQUE,"+
      "event_type TEXT NOT NULL,"+
      "occurred_at_ms INTEGER NOT NULL,"+
      "details TEXT NOT NULL,"+
      "status TEXT NOT NULL CHECK(status IN ('PENDING','ACKED')))");
    db.execSQL("CREATE INDEX events_status ON events(status,seq)");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){
    throw new IllegalStateException("Telemetry database requires non-destructive migration");
  }
  public static boolean enabled(Context c){
    return c.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getBoolean(KEY_ENABLED,true);
  }
  public static boolean setEnabled(Context c,boolean enable){
    SharedPreferences p=c.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    if(!p.edit().putBoolean(KEY_ENABLED,enable).commit())return false;
    if(!enable){
      try(AgentTelemetry t=new AgentTelemetry(c)){t.clearLocal();}
      catch(Exception ignored){}
    }else{
      note(c,"DIAGNOSTIC_ENABLED","MANUAL","IDLE","NONE");
    }
    return true;
  }
  private static String network(Context c){
    try{
      ConnectivityManager cm=(ConnectivityManager)c.getSystemService(Context.CONNECTIVITY_SERVICE);
      if(cm==null)return "UNKNOWN";
      NetworkInfo n=cm.getActiveNetworkInfo();
      if(n==null||!n.isConnected())return "NONE";
      if(n.getType()==ConnectivityManager.TYPE_WIFI)return "WIFI";
      if(n.getType()==ConnectivityManager.TYPE_MOBILE)return "CELLULAR";
      return "OTHER";
    }catch(Exception ignored){return "UNKNOWN";}
  }
  public static void note(Context c,String type,String source,String phase,String error){
    if(!enabled(c))return;
    try{
      TelemetryContractV1.valid(type,source,phase,error);
      JSONObject details=new JSONObject();
      details.put("source",source);
      details.put("phase",phase);
      details.put("error",error);
      details.put("network",network(c));
      try(AgentOutbox out=new AgentOutbox(c)){
        details.put("pending",Math.min(1000000,Math.max(0,out.count("PENDING"))));
        details.put("acked",Math.min(1000000,Math.max(0,out.count("ACKED"))));
      }catch(Exception ignored){}
      try(AgentTelemetry queue=new AgentTelemetry(c)){
        queue.record(type,details);
      }
      AgentSyncScheduler.schedule(c);
    }catch(Exception ignored){/* telemetry must never prevent a command, audio or UI action */}
  }
  public synchronized long record(String eventType,JSONObject details)throws Exception{
    if(!TelemetryContractV1.TYPES.contains(eventType))
      throw new IllegalArgumentException("INVALID_EVENT_TYPE");
    // Details keys and values are validated locally AND independently by the VPS.
    if(details.length()>7)throw new IllegalArgumentException("DETAILS_TOO_LARGE");
    for(java.util.Iterator<String> keys=details.keys();keys.hasNext();){
      String key=keys.next();
      if("pending".equals(key)||"acked".equals(key)||"value".equals(key)){
        Object v=details.opt(key);
        if(!(v instanceof Integer)||((Integer)v)<0||((Integer)v)>1000000)
          throw new IllegalArgumentException("INVALID_COUNT");
      }else{
        String value=details.optString(key,"");
        if("source".equals(key)&&!TelemetryContractV1.SOURCES.contains(value) ||
           "phase".equals(key)&&!TelemetryContractV1.PHASES.contains(value) ||
           "error".equals(key)&&!TelemetryContractV1.ERRORS.contains(value) ||
           "network".equals(key)&&!TelemetryContractV1.NETWORKS.contains(value) ||
           !("source".equals(key)||"phase".equals(key)||"error".equals(key)||"network".equals(key)))
          throw new IllegalArgumentException("INVALID_ENUM");
      }
    }
    SQLiteDatabase db=getWritableDatabase();
    db.beginTransaction();
    try{
      ContentValues row=new ContentValues();
      row.put("event_id",UUID.randomUUID().toString().replace("-",""));
      row.put("event_type",eventType);
      row.put("occurred_at_ms",System.currentTimeMillis());
      row.put("details",details.toString());
      row.put("status","PENDING");
      long seq=db.insertOrThrow("events",null,row);
      db.execSQL("DELETE FROM events WHERE seq NOT IN "+
        "(SELECT seq FROM events ORDER BY seq DESC LIMIT "+MAX_LOCAL+")");
      db.setTransactionSuccessful();
      return seq;
    }finally{db.endTransaction();}
  }
  public synchronized List<JSONObject> pending(int count)throws Exception{
    if(count<1||count>30)throw new IllegalArgumentException("INVALID_BATCH");
    List<JSONObject> list=new ArrayList<>();
    try(Cursor c=getReadableDatabase().rawQuery(
        "SELECT seq,event_id,event_type,occurred_at_ms,details "+
        "FROM events WHERE status='PENDING' ORDER BY seq LIMIT ?",
        new String[]{Integer.toString(count)})){
      while(c.moveToNext()){
        JSONObject o=new JSONObject();
        o.put("schema",TelemetryContractV1.SCHEMA);
        o.put("event_id",c.getString(1));
        o.put("seq",c.getLong(0));
        o.put("version_code",TelemetryContractV1.VERSION_CODE);
        o.put("event_type",c.getString(2));
        o.put("occurred_at_ms",c.getLong(3));
        o.put("details",new JSONObject(c.getString(4)));
        list.add(o);
      }
    }
    return list;
  }
  public synchronized boolean acknowledge(JSONObject r,String eventId,long seq)throws Exception{
    if(!TelemetryContractV1.validReply(eventId,seq,r.optString("schema",""),
      r.optString("event_id",""),r.optLong("seq",-1),
      r.optString("state",""),r.opt("duplicate"),r.opt("executed")))
      throw new IllegalArgumentException("TELEMETRY_RECEIPT_MISMATCH");
    SQLiteDatabase db=getWritableDatabase();
    db.beginTransaction();
    try(Cursor c=db.rawQuery("SELECT status FROM events WHERE seq=? AND event_id=?",
      new String[]{Long.toString(seq),eventId})){
      if(!c.moveToFirst())throw new IllegalArgumentException("EVENT_NOT_FOUND");
      boolean already="ACKED".equals(c.getString(0));
      if(!already){
        ContentValues vals=new ContentValues();vals.put("status","ACKED");
        if(db.update("events",vals,"seq=? AND event_id=? AND status='PENDING'",
          new String[]{Long.toString(seq),eventId})!=1)
          throw new IllegalStateException("ACK_RACE");
      }
      db.setTransactionSuccessful();return !already;
    }finally{db.endTransaction();}
  }
  public synchronized int count(String state){
    if(!"PENDING".equals(state)&&!"ACKED".equals(state))
      throw new IllegalArgumentException("INVALID_STATE");
    try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM events WHERE status=?",
      new String[]{state})){
      c.moveToFirst();return c.getInt(0);
    }
  }
  public synchronized void clearLocal(){
    getWritableDatabase().delete("events",null,null);
    // seq AUTOINCREMENT remains monotonic to preserve dedupe even after clear.
  }
}
