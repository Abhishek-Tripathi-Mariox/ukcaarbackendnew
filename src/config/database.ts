import mongoose from 'mongoose';
import { config } from './index';

export const connectDB = async (): Promise<void> => {
  try {
    const conn = await mongoose.connect(config.mongo.uri, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);

    // Drop old unique email index if it exists (email is now optional for new users)
    try {
      const usersCollection = conn.connection.collection('users');
      const indexes = await usersCollection.indexes();
      const emailIndex = indexes.find((idx: any) => idx.key?.email && !idx.sparse);
      if (emailIndex) {
        await usersCollection.dropIndex(emailIndex.name!);
        console.log('✅ Dropped old non-sparse email unique index');
      }
    } catch (e) {
      // Index may not exist, ignore
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    // In development, continue without DB for API testing
    if (config.env === 'development') {
      console.warn('⚠️  Running without MongoDB – some features will be limited');
    } else {
      process.exit(1);
    }
  }
};
