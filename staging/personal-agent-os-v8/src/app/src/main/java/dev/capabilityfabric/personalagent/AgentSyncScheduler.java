package dev.capabilityfabric.personalagent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;

/** OS-owned queued delivery; no foreground wake dependency or raw credential in jobs. */
public final class AgentSyncScheduler {
  private static final int JOB_ID=240415;
  private AgentSyncScheduler(){}
  public static void schedule(Context ctx){
    if(!AgentTransport.paired(ctx))return;
    JobScheduler manager=(JobScheduler)ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    if(manager==null)return;
    JobInfo job=new JobInfo.Builder(JOB_ID,new ComponentName(ctx,AgentSyncJobService.class))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setPersisted(true)
      .setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL)
      .build();
    manager.schedule(job);
  }
}
