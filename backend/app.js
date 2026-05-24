const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const cookieParser = require('cookie-parser');
const morgan  = require('morgan');
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

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} is not permitted.`));
  },
  credentials: true
}));

app.use(globalLimiter);
app.use(cookieParser(process.env.COOKIE_SECRET));

// Webhook needs raw body BEFORE the global JSON parser
app.use('/api/voting/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Routes — only the split routers, no legacy api.js
app.use('/api/auth',   authRoutes);
app.use('/api/voting', votingRoutes);
app.use('/api/admin',  adminRoutes);

// 404
app.use((_req, res) => res.status(404).json({ message: 'Route not found.' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error.' });
});

module.exports = { app };

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`[NACOS API] Running on port ${PORT}`));
}