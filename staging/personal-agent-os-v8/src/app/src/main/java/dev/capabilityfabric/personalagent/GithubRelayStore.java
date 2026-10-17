package dev.capabilityfabric.personalagent;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

/** Independent durable checkpoint: Github Issue creation never ACKs original outbox. */
public final class GithubRelayStore extends SQLiteOpenHelper {
  private static final String DB="agentos-gh-issue-checkpoint-v1.sqlite";
  public static final class Packet {
    public final String id,body,kind;
    public final long issueNumber,lastCheckedMs;
    Packet(String id,String body,String kind,long issue,long checked){
      this.id=id;this.body=body;this.kind=kind;this.issueNumber=issue;this.lastCheckedMs=checked;
    }
  }
  public GithubRelayStore(Context c){super(c,DB,null,1);}
  @Override public void onCreate(SQLiteDatabase db){
    db.execSQL("CREATE TABLE packets(packet_id TEXT PRIMARY KEY,body TEXT NOT NULL,"+
     "kind TEXT NOT NULL CHECK(kind IN ('COMMAND','TELEMETRY')),"+
     "issue_number INTEGER NOT NULL DEFAULT 0,"+
     "last_checked_ms INTEGER NOT NULL DEFAULT 0,created_ms INTEGER NOT NULL)");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int old,int next){
    throw new IllegalStateException("NO_DESTRUCTIVE_CHECKPOINT_MIGRATION");
  }
  public synchronized Packet load(String id){
    try(Cursor c=getReadableDatabase().rawQuery(
      "SELECT body,kind,issue_number,last_checked_ms FROM packets WHERE packet_id=?",
      new String[]{id})){
      return c.moveToFirst()?new Packet(id,c.getString(0),c.getString(1),c.getLong(2),c.getLong(3)):null;
    }
  }
  public synchronized Packet capture(String id,String encryptedBody,String kind)throws Exception{
    if(id==null||!id.matches("[0-9a-f]{32}")||encryptedBody==null||
       encryptedBody.length()>12000||encryptedBody.length()<500||
       !("COMMAND".equals(kind)||"TELEMETRY".equals(kind)))
      throw new IllegalArgumentException("BAD_CHECKPOINT");
    SQLiteDatabase db=getWritableDatabase();
    db.beginTransaction();
    try{
      Packet existing=load(id);
      if(existing!=null){
        if(!kind.equals(existing.kind))throw new IllegalStateException("PACKET_TYPE_CHANGED");
        db.setTransactionSuccessful();return existing;
      }
      ContentValues value=new ContentValues();
      value.put("packet_id",id);value.put("body",encryptedBody);
      value.put("kind",kind);value.put("created_ms",System.currentTimeMillis());
      db.insertOrThrow("packets",null,value);
      Packet made=new Packet(id,encryptedBody,kind,0,0);
      db.setTransactionSuccessful();return made;
    }finally{db.endTransaction();}
  }
  public synchronized void markIssued(String id,long issueNumber){
    if(issueNumber<1)throw new IllegalArgumentException("BAD_ISSUE_NUMBER");
    ContentValues values=new ContentValues();values.put("issue_number",issueNumber);
    int changed=getWritableDatabase().update("packets",values,
       "packet_id=? AND (issue_number=0 OR issue_number=?)",
       new String[]{id,Long.toString(issueNumber)});
    if(changed!=1)throw new IllegalStateException("ISSUE_NUMBER_CONFLICT");
  }
  public synchronized void markChecked(String id){
    ContentValues values=new ContentValues();values.put("last_checked_ms",System.currentTimeMillis());
    getWritableDatabase().update("packets",values,"packet_id=?",new String[]{id});
  }
  public synchronized void forget(String id){
    getWritableDatabase().delete("packets","packet_id=?",new String[]{id});
  }
}
