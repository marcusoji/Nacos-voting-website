const axios = require('axios');

const client = axios.create({
  baseURL : 'https://api.paystack.co',
  headers : {
    Authorization  : `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type' : 'application/json'
  },
  timeout: 25_000  // 25s — Vercel functions have 30s limit; give Paystack plenty of time
});

module.exports = {

  async initializeTx(email, amountInKobo, reference, metadata = {}) {
    // Strip trailing slash so callback never becomes double-slash
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
      amountKobo: amountInKobo,
      callback_url: payload.callback_url,
      email
    });

    const response = await client.post('/transaction/initialize', payload);
    return response.data;
  },

  async verifyTx(reference, expectedAmountInKobo) {
    // Wrap in try/catch so a network error returns { success: false }
    // instead of throwing — prevents marking transactions as failed incorrectly
    try {
      const response = await client.get(
        `/transaction/verify/${encodeURIComponent(reference)}`
      );
      const tx = response.data?.data;

      if (!tx) {
        console.error('[PAYSTACK VERIFY] No data in response:', response.data);
        return { success: false, reason: 'empty_response' };
      }

      console.log('[PAYSTACK VERIFY] Raw response:', {
        reference : tx.reference,
        status    : tx.status,
        currency  : tx.currency,
        amount    : tx.amount,
        expected  : expectedAmountInKobo
      });

      const statusOk   = tx.status    === 'success';
      const refOk      = tx.reference === reference;
      const currencyOk = tx.currency  === 'NGN';
      const amountOk   = Number(tx.amount) === expectedAmountInKobo;

      if (!statusOk || !refOk || !currencyOk || !amountOk) {
        console.warn('[PAYSTACK VERIFY] Validation failed:', {
          statusOk, refOk, currencyOk, amountOk,
          gotAmount: tx.amount, expected: expectedAmountInKobo
        });
      }

      return {
        success: statusOk && refOk && currencyOk && amountOk,
        rawData: tx
      };

    } catch (err) {
      // Network/timeout error — do NOT mark transaction as failed
      // The transaction may be genuinely successful; webhook will handle it
      console.error('[PAYSTACK VERIFY ERROR]', err.message, {
        reference,
        isTimeout: err.code === 'ECONNABORTED',
        status: err.response?.status,
        data: err.response?.data
      });
      // Return a special flag so the caller knows this was a network error
      // not a genuine payment failure
      return { success: false, reason: 'network_error', networkError: true };
    }
  }
};
