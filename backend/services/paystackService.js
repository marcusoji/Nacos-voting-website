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
    const frontendBase = (process.env.FRONTEND_URL || '').split(',')[0].trim();
    const response = await client.post('/transaction/initialize', {
      email,
      amount       : amountInKobo,
      reference,
      currency     : 'NGN',
      metadata,
      callback_url : `${frontendBase}/payment-success.html`
    });
    return response.data;
  },

  async verifyTx(reference, expectedAmountInKobo) {
    const response = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
    const tx = response.data?.data;
    if (!tx) return { success: false };

    const valid =
      tx.status    === 'success' &&
      tx.reference === reference &&
      tx.currency  === 'NGN'    &&
      Number(tx.amount) === expectedAmountInKobo;

    return { success: valid, rawData: tx };
  }
};