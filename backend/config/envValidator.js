const validateEnvironment = () => {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PAYSTACK_SECRET_KEY',
    'COOKIE_SECRET',
    'FRONTEND_URL'
  ];

  const missing = required.filter(k => !process.env[k]);

  if (missing.length > 0) {
    throw new Error(
      `[STARTUP FATAL] Missing required env variables: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in all values.'
    );
  }
};

module.exports = { validateEnvironment };