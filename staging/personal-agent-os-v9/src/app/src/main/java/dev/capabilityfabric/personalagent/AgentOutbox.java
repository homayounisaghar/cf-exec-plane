package dev.capabilityfabric.personalagent;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Persistent, immutable command.v2 queue. The server receipt proves QUEUED only, not execution. */
public final class AgentOutbox extends SQLiteOpenHelper {
  private static final String DB="agentos-owner-outbox-v2.sqlite";
  public static final String PREF_WORK="agentos_selected_work";
  public static final String KEY_WORK="current_work";
  public static final class Captured {
    public final long sequence;
    public final String text;
    Captured(long sequence,String text){this.sequence=sequence;this.text=text;}
  }
  public AgentOutbox(Context ctx){super(ctx,DB,null,1);}
  @Override public void onCreate(SQLiteDatabase db){
    db.execSQL("CREATE TABLE outbox ("+
      "seq INTEGER PRIMARY KEY AUTOINCREMENT,"+
      "command_id TEXT NOT NULL UNIQUE,"+
      "text TEXT NOT NULL, sha256 TEXT NOT NULL, work_id TEXT,"+
      "origin TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','ACKED')),"+
      "receipt_id TEXT, created_ms INTEGER NOT NULL, ack_ms INTEGER)");
    db.execSQL("CREATE INDEX outbox_by_status ON outbox(state,seq)");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int from,int to){
    throw new IllegalStateException("Refusing destructive outbox migration");
  }
  private ContentValues values(String id,String text,String work,String origin) throws Exception{
    IngressContractV2.validate(text,work);
    ContentValues c=new ContentValues();
    c.put("command_id",id);c.put("text",text);c.put("sha256",IngressContractV2.digest(text));
    c.put("work_id",work);c.put("origin",origin);c.put("state","PENDING");
    c.put("created_ms",System.currentTimeMillis());
    return c;
  }
  public synchronized long captureVoice(String text,String work) throws Exception{
    return getWritableDatabase().insertOrThrow("outbox",null,values(UUID.randomUUID().toString(),text,work,"voice"));
  }
  public synchronized String enqueueManual(String text,String work) throws Exception{
    String id=UUID.randomUUID().toString();
    getWritableDatabase().insertOrThrow("outbox",null,values(id,text,work,"manual"));
    return id;
  }
  public synchronized Captured latestVoice(){
    try(Cursor c=getReadableDatabase().rawQuery(
      "SELECT seq,text FROM outbox WHERE origin='voice' ORDER BY seq DESC LIMIT 1",null)){
      return c.moveToFirst()?new Captured(c.getLong(0),c.getString(1)):null;
    }
  }
  public synchronized List<JSONObject> pending(int max) throws Exception{
    if(max<1||max>50)throw new IllegalArgumentException("INVALID_BATCH");
    List<JSONObject> result=new ArrayList<>();
    try(Cursor c=getReadableDatabase().rawQuery(
      "SELECT command_id,text,sha256,work_id FROM outbox WHERE state='PENDING' ORDER BY seq LIMIT ?",
      new String[]{Integer.toString(max)})){
      while(c.moveToNext()){
        JSONObject j=new JSONObject();
        j.put("schema",IngressContractV2.COMMAND_SCHEMA);
        j.put("command_id",c.getString(0));j.put("text",c.getString(1));j.put("sha256",c.getString(2));
        j.put("work_id",c.isNull(3)?JSONObject.NULL:c.getString(3));result.add(j);
      }
    }
    return result;
  }
  public synchronized boolean acknowledge(JSONObject ack,String id) throws Exception{
    SQLiteDatabase db=getWritableDatabase();
    db.beginTransaction();
    try(Cursor c=db.rawQuery("SELECT sha256,work_id,state,receipt_id FROM outbox WHERE command_id=?",new String[]{id})){
      if(!c.moveToFirst())throw new IllegalArgumentException("UNKNOWN_COMMAND");
      String sha=c.getString(0),work=c.isNull(1)?null:c.getString(1),state=c.getString(2);
      Object rawWork=ack.opt("work_id");
      if(rawWork!=null && rawWork!=JSONObject.NULL && !(rawWork instanceof String))
        throw new IllegalArgumentException("INVALID_WORK_RECEIPT");
      String replyWork=rawWork==null||rawWork==JSONObject.NULL?null:(String)rawWork;
      boolean valid=IngressContractV2.validReceipt(id,sha,work,
        ack.optString("schema",null),ack.optString("command_id",null),
        ack.optString("sha256",null),replyWork,ack.optString("receipt_id",null),
        ack.optString("state",null),ack.optString("receipt",null),
        ack.opt("executed"),ack.opt("duplicate"));
      if(!valid)throw new IllegalArgumentException("RECEIPT_MISMATCH");
      String receiptId=ack.getString("receipt_id");
      if("ACKED".equals(state)){
        if(!receiptId.equals(c.getString(3)))throw new IllegalArgumentException("RECEIPT_ID_CHANGED");
        db.setTransactionSuccessful();return false;
      }
      if(!"PENDING".equals(state))throw new IllegalStateException("INVALID_STATE");
      ContentValues vals=new ContentValues();
      vals.put("state","ACKED");vals.put("receipt_id",receiptId);
      vals.put("ack_ms",System.currentTimeMillis());
      int changed=db.update("outbox",vals,"command_id=? AND state='PENDING'",new String[]{id});
      if(changed!=1)throw new IllegalStateException("ACK_RACE");
      db.setTransactionSuccessful();return true;
    }finally{db.endTransaction();}
  }
  /** Per-work delivery counters; never conflates ACKED with execution. */
  public synchronized JSONObject localWorkCounts() throws Exception {
    JSONObject result=new JSONObject();
    try(Cursor c=getReadableDatabase().rawQuery(
       "SELECT work_id,state,COUNT(*) FROM outbox GROUP BY work_id,state",null)){
      while(c.moveToNext()){
        String key=c.isNull(0)?"":c.getString(0);
        JSONObject w=result.optJSONObject(key);
        if(w==null){w=new JSONObject();result.put(key,w);}
        w.put(c.getString(1),c.getInt(2));
      }
    }
    return result;
  }
  public synchronized int count(String state){
    if(!"PENDING".equals(state)&&!"ACKED".equals(state))throw new IllegalArgumentException("INVALID_STATE");
    try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM outbox WHERE state=?",new String[]{state})){
      c.moveToFirst();return c.getInt(0);
    }
  }
}
