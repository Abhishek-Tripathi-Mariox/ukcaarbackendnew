import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import config from './config';
import { connectDB } from './config/database';
import { initFirebaseAdmin } from './config/firebase';
import routes from './routes';
import { errorHandler, notFound } from './middleware/errorHandler';
import { initializeSocket } from './socket';

initFirebaseAdmin();

// ── App ──
const app = express();
const httpServer = createServer(app);

// ── Socket.IO ──
initializeSocket(httpServer);

// ── Debug: Log ALL incoming requests (first middleware) ──
app.use((req, _res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip || req.headers['x-forwarded-for']}`);
  next();
});

// ── Security ──
app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: config.rateLimit.max,
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Auth endpoints get stricter limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many auth attempts' },
});
app.use('/api/v1/auth/', authLimiter);

// ── Body parsing ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Compression ──
app.use(compression());

// ── Logging ──
if (config.nodeEnv === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// ── Static files ──
app.use('/uploads', express.static('uploads'));

// ── API Routes ──
app.use('/api/v1', routes);

// ── Root ──
app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: '🚗 UKCAAR API Server',
    version: '1.0.0',
    docs: '/api/v1/health',
  });
});

// ── Error handling ──
app.use(notFound);
app.use(errorHandler);

// ── Start ──
const PORT = config.port;

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    httpServer.listen(PORT, () => {
      console.log('═══════════════════════════════════════');
      console.log(`  UKCAAR API Server`);
      console.log(`  Environment: ${config.nodeEnv}`);
      console.log(`  Port: ${PORT}`);
      console.log(`  Health: http://localhost:${PORT}/api/v1/health`);
      console.log('═══════════════════════════════════════');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
