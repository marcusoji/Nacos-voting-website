const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const cookieParser = require('cookie-parser');
const morgan     = require('morgan');
require('dotenv').config();

const { validateEnvironment } = require('./config/envValidator');
validateEnvironment();

const authRoutes   = require('./routes/authRoutes');
const votingRoutes = require('./routes/votingRoutes');
const adminRoutes  = require('./routes/adminRoutes');
const { globalLimiter } = require('./middleware/rateLimiter');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Helmet ─────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'", 'https://js.paystack.co'],
      styleSrc   : ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc    : ["'self'", 'https://fonts.gstatic.com'],
      imgSrc     : ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc : ["'self'", 'https://api.paystack.co', 'https://*.supabase.co'],
      frameSrc   : ["'self'", 'https://js.paystack.co']
    }
  }
}));

// ── CORS ───────────────────────────────────────────────────────
// FIX 1: Strip trailing slashes when building the allowed list.
// FIX 2: In dev/no-config fallback, allow all origins so local testing never breaks.
// FIX 3: Handle OPTIONS preflight explicitly before any other middleware.
const rawOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim().replace(/\/$/, ''))   // remove trailing slash
  .filter(Boolean);

// Always include localhost variants for dev
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:5501',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501',
  'http://127.0.0.1:3000'
];

const allowedOrigins = [...new Set([...rawOrigins, ...DEV_ORIGINS])];

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server requests (no origin header) — e.g. Paystack webhook, health checks
    if (!origin) return callback(null, true);

    // Strip trailing slash from incoming origin for a clean compare
    const cleanOrigin = origin.replace(/\/$/, '');

    if (allowedOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }

    // In development or if no origins configured, allow all
    if (process.env.NODE_ENV !== 'production' || allowedOrigins.length === 0) {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`CORS: Origin ${origin} is not permitted.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
  maxAge: 86400 // cache preflight for 24h
};

// Handle OPTIONS preflight for ALL routes BEFORE any other middleware
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// ── Middleware ─────────────────────────────────────────────────
app.use(globalLimiter);
app.use(cookieParser(process.env.COOKIE_SECRET));

// Webhook needs raw body BEFORE the global JSON parser
app.use('/api/voting/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Routes ─────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use('/api/auth',   authRoutes);
app.use('/api/voting', votingRoutes);
app.use('/api/admin',  adminRoutes);

// 404
app.use((_req, res) => res.status(404).json({ message: 'Route not found.' }));

// Global error handler — never expose stack traces in production
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const message = (process.env.NODE_ENV === 'production' && status === 500)
    ? 'Internal server error.'
    : (err.message || 'Internal server error.');
  console.error(`[ERROR ${status}]`, err.message);
  res.status(status).json({ message });
});

module.exports = { app };

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`[NACOS API] Running on port ${PORT}`);
    console.log(`[CORS] Allowed origins: ${allowedOrigins.join(', ')}`);
  });
}