const axios = require('axios');

const client = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    'Authorization': 'Bearer ' + process.env.PAYSTACK_SECRET_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 25000
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
      amount      : Number(amountInKobo),
      reference,
      currency    : 'NGN',
      metadata,
      callback_url: frontendBase + '/payment-success.html'
    };

    console.log('[PAYSTACK INIT] Sending:', {
      reference,
      amountKobo: payload.amount,
      callback_url: payload.callback_url,
      email
    });

    try {
      const response = await client.post('/transaction/initialize', payload);
      return response.data;
    } catch (err) {
      const upstreamStatus = err.response?.status;
      const upstreamMsg    = err.response?.data?.message || err.message;
      console.error('[PAYSTACK INIT ERROR]', upstreamStatus, upstreamMsg);
      if (upstreamStatus === 401) {
        throw Object.assign(new Error('Payment gateway authentication failed. Please contact support.'), { status: 502 });
      }
      throw Object.assign(new Error('Payment gateway error. Please try again.'), { status: 502 });
    }
  },

  async verifyTx(reference, expectedAmountInKobo) {
    try {
      const response = await client.get(
        '/transaction/verify/' + encodeURIComponent(reference)
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
};
