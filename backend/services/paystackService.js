const axios = require('axios');

const client = axios.create({
  baseURL : 'https://api.paystack.co',
  headers : {
    Authorization  : `Beconst axios = require('axios');

const client = axios.create({
  baseURL : 'https://api.paystack.co',
  headers : {
    Authorization  : `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type' : 'application/json'
  },
  timeout: 25_000  // 25s — Vercel functions have 30s limit; give Paystack plenty of time
});

/**
 * Calculates what Paystack charges a customer when "Pass fees to customers" is enabled.
 * All math is processed in Kobo to completely avoid JavaScript floating-point issues.
 * @param {number} targetAmountInKobo - The net amount you want to receive (e.g., 60000 for ₦600)
 * @returns {number} The final total amount the customer pays in Kobo (including fees)
 */
function calculatePaystackTotalWithFees(targetAmountInKobo) {
  const targetNaira = targetAmountInKobo / 100;
  
  // Paystack local standard fees rule: 1.5% + ₦100. ₦100 flat fee waived if total under ₦2500.
  let flatFeeNaira = targetNaira < 2500 ? 0 : 100;
  const percentageRate = 0.015; // 1.5%
  const maxFeeNaira = 2000;

  // Paystack's exact reverse engineering formula
  let finalAmountNaira = (targetNaira + flatFeeNaira) / (1 - percentageRate);
  let totalFeeNaira = finalAmountNaira - targetNaira;

  // Check if calculated fee exceeds the ₦2,000 cap
  if (totalFeeNaira > maxFeeNaira) {
    finalAmountNaira = targetNaira + maxFeeNaira;
  }

  // Round up safely and convert back to Kobo integer
  return Math.ceil(finalAmountNaira * 100);
}

module.exports = {

  async initializeTx(email, amountInKobo, reference, metadata = {}) {
    // Strip trailing slash so callback never becomes double-slash
    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0].trim().replace(/\/+$/, '');

    const payload = {
      email,
      amount      : Number(amountInKobo), // Type-safe cast
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

      // Calculate expected total with customer transaction fees added
      const expectedTotalWithFees = calculatePaystackTotalWithFees(Number(expectedAmountInKobo));

      console.log('[PAYSTACK VERIFY] Raw response:', {
        reference : tx.reference,
        status    : tx.status,
        currency  : tx.currency,
        amountPaid: tx.amount,
        expectedBase: expectedAmountInKobo,
        expectedWithFees: expectedTotalWithFees
      });

      const statusOk   = tx.status    === 'success';
      const refOk      = tx.reference === reference;
      const currencyOk = tx.currency  === 'NGN';
      
      // FIX: Matches base price OR matches price with passed checkout fees mathematically
      const actualPaid = Number(tx.amount);
      const amountOk   = actualPaid === Number(expectedAmountInKobo) || actualPaid === expectedTotalWithFees;

      if (!statusOk || !refOk || !currencyOk || !amountOk) {
        console.warn('[PAYSTACK VERIFY] Validation failed:', {
          statusOk, refOk, currencyOk, amountOk,
          gotAmount: tx.amount, 
          expectedBase: expectedAmountInKobo,
          expectedWithFees: expectedTotalWithFees
        });
      }

      return {
        success: statusOk && refOk && currencyOk && amountOk,
        rawData: tx
      };

    } catch (err) {
      console.error('[PAYSTACK VERIFY ERROR]', err.message, {
        reference,
        isTimeout: err.code === 'ECONNABORTED',
        status: err.response?.status,
        data: err.response?.data
      });
      return { success: false, reason: 'network_error', networkError: true };
    }
  }
};arer ${process.env.PAYSTACK_SECRET_KEY}`,
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
      amount      : Number(amountInKobo), // Type-safe cast
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
      // FIX: Force both sides to Numbers to avoid string vs number mismatch from DB or JSON
      const amountOk   = Number(tx.amount) === Number(expectedAmountInKobo);

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
