const axios = require('axios');

const client = axios.create({
  baseURL : 'https://api.paystack.co',
  headers : {
    Authorization  : `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type' : 'application/json'
  },
  timeout: 25_000 
});

module.exports = {

  async initializeTx(email, amountInKobo, reference, metadata = {}) {
    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0].trim().replace(/\/+$/, '');

    const payload = {
      email,
      amount      : Number(amountInKobo), // Ensure it's a number
      reference,
      currency    : 'NGN',
      metadata,
      callback_url: `${frontendBase}/payment-success.html`
    };

    console.log('[PAYSTACK INIT] Sending:', {
      reference,
      amountKobo: payload.amount,
      callback_url: payload.callback_url,
      email
    });

    try {
      const response = await client.post('/transaction/initialize', payload);
      // Return Paystack's inner data object directly for cleaner frontend usage
      return response.data; 
    } catch (err) {
      console.error('[PAYSTACK INIT ERROR]', err.response?.data || err.message);
      throw err;
    }
  },

  async verifyTx(reference, expectedAmountInKobo) {
    try {
      const response = await client.get(
        `/transaction/verify/${encodeURIComponent(reference)}`
      );
      
      const paystackResponse = response.data;
      const tx = paystackResponse?.data;

      if (!paystackResponse?.status || !tx) {
        console.error('[PAYSTACK VERIFY] Paystack rejected query:', paystackResponse);
        return { success: false, reason: 'invalid_reference' };
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
      // FIX: Force both to numbers to avoid string vs number mismatch
      const amountOk   = Number(tx.amount) === Number(expectedAmountInKobo);

      if (!statusOk || !refOk || !currencyOk || !amountOk) {
        console.warn('[PAYSTACK VERIFY] Validation failed details:', {
          statusOk, refOk, currencyOk, amountOk,
          gotStatus: tx.status,
          gotAmount: tx.amount, expected: expectedAmountInKobo,
          gotCurrency: tx.currency
        });
      }

      return {
        success: statusOk && refOk && currencyOk && amountOk,
        rawData: tx
      };

    } catch (err) {
      // Catching 404s/400s specifically from Paystack API
      if (err.response) {
        console.error('[PAYSTACK VERIFY API ERROR]', {
          status: err.response.status,
          data: err.response.data
        });
        return { success: false, reason: 'api_error', details: err.response.data };
      }

      // True network/timeout errors
      console.error('[PAYSTACK VERIFY NETWORK ERROR]', err.message, {
        reference,
        isTimeout: err.code === 'ECONNABORTED'
      });
      return { success: false, reason: 'network_error', networkError: true };
    }
  }
};
