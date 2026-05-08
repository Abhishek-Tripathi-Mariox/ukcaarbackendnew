require('dotenv').config();
const m = require('mongoose');
const bcrypt = require('bcryptjs');
m.connect(process.env.MONGODB_URI).then(async () => {
  const hash = await bcrypt.hash('Admin@12345', 10);
  const r = await m.connection.db.collection('users').updateOne({ email: 'admin@ukcaar.com' }, { $set: { password: hash } });
  console.log('matched:', r.matchedCount, 'modified:', r.modifiedCount);
  process.exit(0);
});
