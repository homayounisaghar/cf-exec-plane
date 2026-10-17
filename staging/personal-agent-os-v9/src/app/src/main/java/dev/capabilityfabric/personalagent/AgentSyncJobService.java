package dev.capabilityfabric.personalagent;
import android.app.job.JobParameters;
import android.app.job.JobService;

/** Android may defer background work while offline or in Doze. */
public final class AgentSyncJobService extends JobService {
  @Override public boolean onStartJob(JobParameters params){
    new Thread(()->{
      AgentTransport.Report report=AgentTransport.syncOnce(this,50);
      AgentTransport.TelemetryReport telemetry=AgentTransport.syncTelemetry(this,30);
      // Experimental offline fallback is opt-in. Before signed phone test,
      // no personal commands or background GitHub posts are permitted.
      if(GithubRelayVault.backgroundAllowed(this) &&
          (report.remaining>0||telemetry.remaining>0))
        GithubRelayTransport.sync(this,false);
      boolean more="MORE_PENDING".equals(report.detail)||
                    "MORE_PENDING".equals(telemetry.detail);
      if(more)AgentSyncScheduler.schedule(this);
      boolean retry=AgentTransport.paired(this) &&
                    (report.remaining>0||telemetry.remaining>0) && !more;
      jobFinished(params,retry);
    },"agentos-ingress-sync").start();
    return true;
  }
  @Override public boolean onStopJob(JobParameters params){return true;}
}
