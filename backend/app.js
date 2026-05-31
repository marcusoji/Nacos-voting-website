const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
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

// ── Helmet ────────────────────────────────────────────────────
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

// ── CORS ──────────────────────────────────────────────────────
const corsOptions = {
  origin(origin, cb) {
    const allowed = (process.env.FRONTEND_URL || '')
      .split(',')
      .map(o => o.trim().replace(/\/$/, ''))
      .filter(Boolean);

    if (!origin) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') return cb(null, true);

    const clean = origin.replace(/\/$/, '');
    if (allowed.includes(clean)) return cb(null, true);

    console.warn(`[CORS] Blocked: ${origin}`);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials   : true,
  methods       : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge        : 86400
};

// OPTIONS preflight before rate limiter and all other middleware
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// ── Core middleware ───────────────────────────────────────────
app.use(globalLimiter);

// Webhook needs raw body BEFORE the JSON parser
app.use('/api/voting/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Routes ────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use('/api/auth',   authRoutes);
app.use('/api/voting', votingRoutes);
app.use('/api/admin',  adminRoutes);

// 404
app.use((_req, res) => res.status(404).json({ message: 'Route not found.' }));

// Global error handler
app.use((err, _req, res, _next) => {
  // Axios errors from upstream services (e.g. Paystack) should never
  // leak their HTTP status to the client — always map them to 502.
  const isAxiosError = !!(err.response && err.config);
  const status  = isAxiosError ? 502 : (err.status || err.statusCode || 500);
  const message = isAxiosError
    ? 'Payment gateway error. Please try again.'
    : ((process.env.NODE_ENV === 'production' && status === 500)
        ? 'Internal server error.'
        : (err.message || 'Internal server error.'));
  console.error(`[ERROR ${status}]`, err.message, isAxiosError ? `(upstream ${err.response?.status})` : '');
  res.status(status).json({ message });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`[NACOS API] Running on port ${PORT}`);
    console.log(`[CORS] FRONTEND_URL = "${process.env.FRONTEND_URL}"`);
  });
}
