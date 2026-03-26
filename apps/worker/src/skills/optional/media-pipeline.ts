import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { processMediaJob } from "../../media/processor";

export const mediaPipelineWorker: WorkerSkillContribution = {
  skillName: "media.pipeline",
  jobs: [
    {
      kind: "media.process",
      process: async ({ pool, data }) => {
        await processMediaJob({ pool, tenantId: data.tenantId, jobId: data.jobId, fsRootDir: data.fsRootDir });
      },
    },
  ],
};
