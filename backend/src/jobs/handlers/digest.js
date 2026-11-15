// digest.generate { periodEnd }   all weekly digests for one cut-off (services/digest)
// digest.deliver { recipientId }   e-mail / Teams delivery of one recipient's copy
import { deliver, generate, markDeliveryFailed } from '../../services/digest/index.js';

export const digestGenerate = { run: async (job) => generate(job.payload.periodEnd, { actorId: job.payload.actorId ?? null }) };
export const digestDeliver = {
  run: async (job) => deliver(job.payload.recipientId),
  async onFailure(job, err, { final }) {
    if (final) await markDeliveryFailed(job.payload.recipientId, err);
  },
};
