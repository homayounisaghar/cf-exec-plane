package dev.capabilityfabric.personalagent;
import android.content.Context;
import android.content.SharedPreferences;

/** Alpha3-compatible voice handoff. New voice captures are queued BEFORE success dings. */
public final class CommandInbox {
  public static final String PREFS="agent_os_voice_handoff";
  public static final String KEY_SEQUENCE="sequence";
  public static final String KEY_TEXT="last_command";
  private CommandInbox(){}
  public static long capture(Context context,String text){
    String work=context.getSharedPreferences(AgentOutbox.PREF_WORK,Context.MODE_PRIVATE)
      .getString(AgentOutbox.KEY_WORK,"");
    try(AgentOutbox queue=new AgentOutbox(context)){
      long seq=queue.captureVoice(text,work==null||work.isEmpty()?null:work);
      AgentTelemetry.note(context,"QUEUE_CAPTURED","WAKE","PENDING","NONE");
      AgentSyncScheduler.schedule(context);
      return seq;
    }catch(Exception ignored){return -1L;}
  }
  public static long latestSequence(Context context){
    try(AgentOutbox queue=new AgentOutbox(context)){
      AgentOutbox.Captured c=queue.latestVoice();return c==null?0L:c.sequence;
    }catch(Exception ignored){return 0L;}
  }
  public static String latest(Context context){
    try(AgentOutbox queue=new AgentOutbox(context)){
      AgentOutbox.Captured c=queue.latestVoice();if(c!=null)return c.text;
    }catch(Exception ignored){}
    SharedPreferences old=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    return old.getString(KEY_TEXT,"(none yet)");
  }
}
