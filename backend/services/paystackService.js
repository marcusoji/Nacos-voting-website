const axios = require('axios');

const client = axios.create({
  baseURL : 'https://api.paystack.co',
  headers : {
    Authorization  : `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type' : 'application/json'
  },
  timeout: 15_000
});

module.exports = {
  async initializeTx(email, amountInKobo, reference, metadata = {}) {
    // FIX: strip trailing slash from FRONTEND_URL before building callback_url
    // Without this, callback becomes "...//.payment-success.html" → 404 on Vercel
    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0]
      .trim()
      .replace(/\/$/, '');   // <-- this was missing

    const response = await client.post('/transaction/initialize', {
      email,
      amount      : amountInKobo,
      reference,
      currency    : 'NGN',
      metadata,
      callback_url: `${frontendBase}/payment-success.html`
    });
    return response.data;
  },

  async verifyTx(reference, expectedAmountInKobo) {
    const response = await client.get(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );
    const tx = response.data?.data;
    if (!tx) return { success: false, reason: 'No data returned from Paystack' };

    // Log for debugging on Vercel
    console.log('[PAYSTACK VERIFY]', {
      ref     : reference,
      status  : tx.status,
      currency: tx.currency,
      amount  : tx.amount,
      expected: expectedAmountInKobo
    });

    const valid =
      tx.status    === 'success' &&
      tx.reference === reference &&
      tx.currency  === 'NGN'    &&
      Number(tx.amount) === expectedAmountInKobo;

    if (!valid) {
      console.warn('[PAYSTACK VERIFY FAILED]', {
        statusOk  : tx.status === 'success',
        refOk     : tx.reference === reference,
        currencyOk: tx.currency === 'NGN',
        amountOk  : Number(tx.amount) === expectedAmountInKobo
      });
    }

    return { success: valid, rawData: tx };
  }
};