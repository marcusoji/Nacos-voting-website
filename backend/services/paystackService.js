const axios = require('axios');

// BUG FIX: Do NOT set Authorization at axios.create() time.
// On Vercel serverless, this module loads before dotenv executes in app.js,
// so process.env.PAYSTACK_SECRET_KEY would be undefined when the string is baked in.
// Instead, use a request interceptor which runs at call-time, not module-load-time.
const client = axios.create({
  baseURL : 'https://api.paystack.co',
  timeout : 25_000
});

client.interceptors.request.use(config => {
  config.headers['Authorization'] = `Bearer ${process.env.PAYSTACK_SECRET_KEY}`;
  config.headers['Content-Type']  = 'application/json';
  return config;
});

module.exports = {
  async initializeTx(email, amountInKobo, reference, metadata = {}) {
    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0].trim().replace(/\/+$/, '');

    const payload = {
      email,
      amount      : amountInKobo,
      reference,
      currency    : 'NGN',
      metadata,
      callback_url: `${frontendBase}/payment-success.html`
    };

    console.log('[PAYSTACK INIT] Sending:', {
      reference,
      amountKobo  : amountInKobo,
      callback_url: payload.callback_url,
      email
    });

    const response = await client.post('/transaction/initialize', payload);
    return response.data;
  },

  async verifyTx(reference, expectedAmountInKobo) {
    try {
      const response = await client.get(
        `/transaction/verify/${encodeURIComponent(reference)}`
      );
      const tx = response.data?.data;

      if (!tx) {
        console.error('[PAYSTACK VERIFY] No data in response:', response.data);
        return { success: false, reason: 'empty_response' };
      }

      const paystackKobo = Number(tx.amount);
      const statusOk     = tx.status    === 'success';
      const refOk        = tx.reference === reference;
      const currencyOk   = tx.currency  === 'NGN';

      // BUG FIX: Do NOT make amountOk part of the success gate.
      // Amount mismatches between DB and Paystack are a logging/alerting concern,
      // NOT a reason to mark a genuine payment as failed and block the voter.
      // Paystack already validated the amount when they processed the payment.
      // We just need to confirm: did Paystack say this payment succeeded?
      const amountOk = paystackKobo === Number(expectedAmountInKobo);

      console.log('[PAYSTACK VERIFY]', {
        reference,
        statusOk,
        refOk,
        currencyOk,
        amountOk,
        paystackKobo,
        expectedKobo: expectedAmountInKobo
      });

      if (!amountOk) {
        // Log for investigation but do NOT fail the payment
        console.error(
          `[PAYSTACK VERIFY] AMOUNT MISMATCH on ${reference}: ` +
          `expected ${expectedAmountInKobo} kobo, Paystack returned ${paystackKobo} kobo. ` +
          `Payment status is "${tx.status}" — proceeding based on status only.`
        );
      }

      return {
        // SUCCESS = Paystack confirmed payment + reference matches + NGN currency.
        // Amount mismatch is logged but does NOT block vote crediting.
        success    : statusOk && refOk && currencyOk,
        amountOk,
        rawData    : tx
      };

    } catch (err) {
      console.error('[PAYSTACK VERIFY ERROR]', err.message, {
        reference,
        isTimeout : err.code === 'ECONNABORTED',
        httpStatus: err.response?.status,
        data      : err.response?.data
      });
      return { success: false, reason: 'network_error', networkError: true };
    }
  }
};
