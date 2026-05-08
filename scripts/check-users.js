require('dotenv').config();
const m = require('mongoose');
m.connect(process.env.MONGODB_URI).then(async () => {
  const coll = m.connection.db.collection('users');
  const total = await coll.countDocuments();
  const byRole = await coll.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]).toArray();
  const sample = await coll
    .find({}, { projection: { role: 1, phone: 1, firstName: 1, lastName: 1, isProfileSetup: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  console.log('total:', total);
  console.log('byRole:', JSON.stringify(byRole));
  console.log('sample:', JSON.stringify(sample, null, 2));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
