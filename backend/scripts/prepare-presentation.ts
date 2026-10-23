import { readFile, writeFile } from 'node:fs/promises';
import { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Factory } from '../src/modules/auth/models/factory.model.js';
import { Subscription } from '../src/modules/billing/models/subscription.model.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';

async function main() {
  const manifest=JSON.parse(await readFile('artifacts/garments-demo-manifest.json','utf8'));
  await connectDatabase();
  const tenantId=new Types.ObjectId(manifest.tenantId);
  const factory=await Factory.findById(tenantId).lean().exec();
  if(!factory?.name.includes('Apparel Demo')||!manifest.users.owner.endsWith('@garments.example.test'))throw new Error('Only the dedicated synthetic presentation factory can be configured');
  await tenantStorage.run({tenantId},()=>Subscription.updateOne({tenantId},{$set:{tier:'enterprise',status:'active',seats:100,scheduledTier:null,cancelAtPeriodEnd:false}}).exec());
  manifest.presentationSubscription={tier:'enterprise',synthetic:true,note:'Presentation-only plan configuration; no purchase, charge or real subscription upgrade. Preserves recorded AI usage while providing capacity for more live demos.'};
  await writeFile('artifacts/garments-demo-manifest.json',JSON.stringify(manifest,null,2));
  console.log('Synthetic presentation factory configured for Enterprise AI quotas. Recorded usage retained; no gateway charge. Login again for updated claims.');
}
main().catch(err=>{console.error(err.message);process.exitCode=1}).finally(disconnectDatabase);
