const fetch = require('node-fetch');

// ==========================================
// 1. CONFIGURATION & KEYS
// ==========================================
// It reads from Vercel Environment Variables, with your current District defaults as fallback
const OSM_CLIENT_ID = process.env.OSM_CLIENT_ID || 'YOUR_OSM_CLIENT_ID_HERE';
const SUMUP_API_KEY = process.env.SUMUP_API_KEY || 'YOUR_SUMUP_API_KEY_HERE';
const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE || 'MCDTTADM';

// Web3Forms Access Key for instant picking slip emails to edward.price@arrowscouts.org.uk
// (Generate in 10 seconds at https://web3forms.com by entering your email)
const WEB3FORMS_KEY = process.env.WEB3FORMS_KEY || 'YOUR_WEB3FORMS_KEY_HERE';

// Default unit price for badges
const DEFAULT_BADGE_PRICE = 0.90;

// Optional price overrides for specific badges by their stock code (SKU)
const PRICE_MAP = {
  // 'SPECIAL-SKU': 1.50,
  // 'STAGED-100': 1.20
};

// ==========================================
// 2. HELPER: DISPATCH PICKING SLIP EMAIL
// ==========================================
async function submitOrderNotification({ orderRef, leaderName, leaderEmail, leaderGroup, paymentType, items, grandTotal }) {
  if (!WEB3FORMS_KEY || WEB3FORMS_KEY === 'YOUR_WEB3FORMS_KEY_HERE') {
    console.warn('WEB3FORMS_KEY is not set. Skipping email dispatch.');
    return;
  }

  const itemsSummary = items
    .map(i => {
      const unit = PRICE_MAP[i.stock_code] !== undefined ? PRICE_MAP[i.stock_code] : DEFAULT_BADGE_PRICE;
      const total = (unit * i.quantity).toFixed(2);
      return `  - ${i.quantity}x ${i.name} [SKU: ${i.stock_code}, Level: ${i.level}] @ £${unit.toFixed(2)} = £${total}`;
    })
    .join('\n');

  const emailBody = `
==================================================
ARROW DISTRICT SCOUT SHOP - NEW BADGE ORDER
==================================================

Order Reference : #${orderRef}
Date            : ${new Date().toLocaleDateString('en-GB')}
Status          : ${paymentType}

LEADER & SECTION DETAILS:
--------------------------------------------------
Leader Name     : ${leaderName}
Scout Group     : ${leaderGroup}
Contact Email   : ${leaderEmail}

PICKING LIST:
--------------------------------------------------
${itemsSummary}

--------------------------------------------------
Total Quantity  : ${items.reduce((sum, i) => sum + i.quantity, 0)} badges
Grand Total     : £${grandTotal.toFixed(2)}
--------------------------------------------------

${
  paymentType.includes('BACS')
    ? '⚠️ ACTION REQUIRED: Verify BACS bank transfer receipt from Group Treasurer before releasing badges.'
    : '✅ CONFIRMED: Payment captured online via SumUp card payment.'
}
`;

  try {
    const res = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        subject: `[Badge Order] #${orderRef} - ${leaderGroup} (${paymentType})`,
        from_name: 'Arrow District Badge Shop',
        replyto: leaderEmail,
        message: emailBody
      })
    });
    const result = await res.json();
    console.log('Email delivery response:', result);
  } catch (err) {
    console.error('Error dispatching email notification:', err);
  }
}

// ==========================================
// 3. MAIN VERCEL SERVERLESS HANDLER
// ==========================================
module.exports = async (req, res) => {
  // -------------------------------------------------------------
  // HANDLER A: INTERNAL POST (SumUp Session & Email Notification)
  // -------------------------------------------------------------
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    await new Promise(resolve => req.on('end', resolve));

    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // Action A1: Create SumUp Checkout Session
    if (payload.action === 'create_sumup') {
      try {
        const sumupRes = await fetch('https://api.sumup.com/v0.1/checkouts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUMUP_API_KEY.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            checkout_reference: payload.orderRef,
            amount: parseFloat(payload.amount),
            currency: 'GBP',
            merchant_code: SUMUP_MERCHANT_CODE.trim(),
            description: payload.description || 'Arrow District Badges'
          })
        });

        const checkoutData = await sumupRes.json();
        if (!sumupRes.ok) {
          return res.status(400).json({ error: checkoutData.message || 'SumUp API error' });
        }
        return res.status(200).json(checkoutData);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Action A2: Send Email Notification to Badge Secretary
    if (payload.action === 'send_notification') {
      await submitOrderNotification(payload);
      return res.status(200).json({ status: 'success' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // -------------------------------------------------------------
  // HANDLER B: INCOMING OSM REDIRECT (GET)
  // -------------------------------------------------------------
  const rawUrl = req.url || '';
  const match = rawUrl.match(/[?&]order_url=([^&]+)/);
  const orderUrl = match ? decodeURIComponent(match[1]) : req.query.order_url;

  if (!orderUrl) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <body style="font-family:sans-serif; max-width:650px; margin:3rem auto; padding:0 1rem; color:#333; line-height:1.5;">
        <h2>Arrow District Scout Shop</h2>
        <p>✅ <b>OSM Integration Endpoint is active and ready on Vercel!</b></p>
        <p>To test this system, open your Online Scout Manager Supplier Control Panel and click <b>Launch test order</b>.</p>
      </body>
    `);
  }

  try {
    // Call OSM server-to-server POST within the 5-minute security window
    const osmEndpoint = `https://www.onlinescoutmanager.co.uk${orderUrl}`;
    const osmResponse = await fetch(osmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Arrow-District-Badge-Shop/1.0'
      },
      body: `client_id=${encodeURIComponent(OSM_CLIENT_ID.trim())}`
    });

    const osmData = await osmResponse.json();

    if (!osmData.status) {
      const errorMsg = typeof osmData.error === 'object' ? JSON.stringify(osmData.error, null, 2) : (osmData.error || 'Session expired');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(400).send(`
        <body style="font-family:sans-serif; max-width:650px; margin:3rem auto; padding:0 1rem; color:#333;">
          <h2 style="color:#c00;">❌ OSM API Error</h2>
          <pre style="background:#f4f4f4; padding:1rem; border-radius:4px;">${errorMsg}</pre>
          <p><small>Note: OSM security tokens expire after 5 minutes. If it expired, launch a fresh test order from OSM.</small></p>
        </body>
      `);
    }

    const sections = osmData.data.sections || [osmData.data.section];
    const badges = osmData.data.badges || [];

    const available = [];
    const unavailable = [];
    let grandTotal = 0;
    let totalBadges = 0;

    badges.forEach(b => {
      if (!b.stock_code) {
        unavailable.push(b);
      } else {
        const unitPrice = PRICE_MAP[b.stock_code] !== undefined ? PRICE_MAP[b.stock_code] : DEFAULT_BADGE_PRICE;
        const lineTotal = unitPrice * b.quantity;
        grandTotal += lineTotal;
        totalBadges += b.quantity;

        available.push({
          ...b,
          unitPrice: unitPrice.toFixed(2),
          lineTotal: lineTotal.toFixed(2)
        });
      }
    });

    const orderRef = `ARROW-${Date.now().toString().slice(-6)}`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Arrow District Badge Shop - Checkout</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <!-- Official SumUp Card Widget SDK -->
        <script type="text/javascript" src="https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js"></script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; color: #333; line-height: 1.5; }
          .header { background: #4d2177; color: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; }
          .warning { background: #fff3cd; border-left: 5px solid #ffc107; padding: 1rem; margin-bottom: 1.5rem; border-radius: 4px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
          th, td { padding: 10px 12px; border: 1px solid #ddd; text-align: left; font-size: 14px; }
          th { background: #f8f9fa; }
          .text-right { text-align: right; }
          .checkout-box { background: #fdfdfd; border: 1px solid #e2e8f0; padding: 1.5rem; border-radius: 8px; margin-top: 1rem; }
          .btn { background: #008751; color: white; border: none; padding: 12px 22px; font-size: 15px; border-radius: 6px; cursor: pointer; display: inline-block; }
          .btn:hover { background: #006e41; }
          .btn-bacs { background: #4d2177; margin-left: 10px; }
          .btn-bacs:hover { background: #3c195e; }
          .form-group { margin-bottom: 12px; }
          .form-group label { display: block; font-size: 13px; font-weight: bold; margin-bottom: 4px; }
          .form-group input { width: 100%; max-width: 420px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; box-sizing: border-box; }
          #sumup-card-container { margin-top: 1.5rem; max-width: 440px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1 style="margin:0; font-size:24px;">Arrow District Scout Shop</h1>
          <p style="margin:5px 0 0; opacity:0.9;">Section: <b>${sections.join(', ').toUpperCase()}</b> | Order Ref: <b>#${orderRef}</b></p>
        </div>

        ${
          unavailable.length > 0
            ? `
          <div class="warning">
            <h3 style="margin:0 0 6px; color:#856404;">⚠️ Items Unable to be Fulfilled</h3>
            <p style="margin:0 0 8px; font-size:14px;">The following custom or unmapped items cannot be supplied through the automated shop and have been excluded from this order:</p>
            <ul style="margin:0; padding-left:20px;">
              ${unavailable.map(b => `<li>${b.name} (Level ${b.level}) — Qty: ${b.quantity}</li>`).join('')}
            </ul>
          </div>
        `
            : ''
        }

        <h3>Order Items</h3>
        ${
          available.length > 0
            ? `
          <table>
            <tr>
              <th>Badge Name</th>
              <th>SKU</th>
              <th>Level</th>
              <th class="text-right">Qty</th>
              <th class="text-right">Unit Price</th>
              <th class="text-right">Total</th>
            </tr>
            ${available
              .map(
                b => `
              <tr>
                <td><b>${b.name}</b></td>
                <td><code>${b.stock_code}</code></td>
                <td>${b.level}</td>
                <td class="text-right">${b.quantity}</td>
                <td class="text-right">&pound;${b.unitPrice}</td>
                <td class="text-right">&pound;${b.lineTotal}</td>
              </tr>
            `
              )
              .join('')}
            <tr style="background:#fafafa; font-weight:bold;">
              <td colspan="3">Grand Total (${totalBadges} badges)</td>
              <td class="text-right">${totalBadges}</td>
              <td></td>
              <td class="text-right">&pound;${grandTotal.toFixed(2)}</td>
            </tr>
          </table>

          <div class="checkout-box">
            <h3 style="margin-top:0;">Leader Contact Details</h3>
            <div class="form-group">
              <label>Your Name:</label>
              <input type="text" id="leaderName" placeholder="e.g. Skip Smith" required>
            </div>
            <div class="form-group">
              <label>Scout Group / Section:</label>
              <input type="text" id="leaderGroup" placeholder="e.g. 14th Eastleigh Cubs" value="${sections.join(', ')}">
            </div>
            <div class="form-group">
              <label>Email for Receipt/Invoice:</label>
              <input type="email" id="leaderEmail" placeholder="skip@example.org.uk" required>
            </div>

            <h3 style="margin-top:1.5rem;">Payment</h3>
            <p style="font-size:14px; color:#666;">Pay securely online with Debit/Credit Card or Apple/Google Pay via SumUp, or request a BACS invoice for your Group Treasurer.</p>

            <div id="payment-buttons">
              <button class="btn" onclick="startSumUpPayment()">💳 Pay &pound;${grandTotal.toFixed(2)} with Card</button>
              <button class="btn btn-bacs" onclick="requestBACS()">🏛️ Request BACS Invoice</button>
            </div>

            <div id="sumup-card-container" style="display:none;">
              <h4>Enter Card Details</h4>
              <div id="sumup-card"></div>
            </div>
          </div>
        `
            : `
          <p><i>No fulfillable items mapped in this order. Please map badges in your OSM control panel.</i></p>
        `
        }

        <script>
          const itemsPayload = ${JSON.stringify(available)};
          const orderRef = '${orderRef}';
          const sections = ${JSON.stringify(sections)};
          const grandTotal = ${grandTotal.toFixed(2)};

          function validateLeader() {
            const name = document.getElementById('leaderName').value.trim();
            const email = document.getElementById('leaderEmail').value.trim();
            if (!name || !email) {
              alert('Please enter your Name and Email so we can record your order and send your receipt.');
              return false;
            }
            return {
              leaderName: name,
              leaderEmail: email,
              leaderGroup: document.getElementById('leaderGroup').value.trim()
            };
          }

          async function notifyServer(paymentType, leaderInfo) {
            await fetch(window.location.pathname, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'send_notification',
                orderRef,
                sections,
                items: itemsPayload,
                grandTotal,
                paymentType,
                ...leaderInfo
              })
            });
          }

          async function startSumUpPayment() {
            const leader = validateLeader();
            if (!leader) return;

            const btn = document.querySelector('.btn');
            btn.disabled = true;
            btn.innerText = 'Initializing payment...';

            try {
              const res = await fetch(window.location.pathname, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'create_sumup',
                  orderRef: orderRef,
                  amount: grandTotal,
                  description: 'Arrow District Badges'
                })
              });

              const data = await res.json();
              if (!res.ok || !data.id) {
                alert('Payment error: ' + (data.error || 'Could not start SumUp checkout.'));
                btn.disabled = false;
                btn.innerText = '💳 Pay &pound;${grandTotal.toFixed(2)} with Card';
                return;
              }

              document.getElementById('sumup-card-container').style.display = 'block';
              document.getElementById('payment-buttons').style.display = 'none';

              SumUpCard.mount({
                id: 'sumup-card',
                checkoutId: data.id,
                onResponse: async function (type, body) {
                  if (type === 'success') {
                    await notifyServer('PAID ONLINE (SumUp Card)', leader);
                    alert('✅ Payment Received! Thank you. Order #' + orderRef + ' has been logged and the picking slip emailed to the Badge Secretary.');
                    window.location.reload();
                  } else if (type === 'error') {
                    alert('Payment declined or encountered an error.');
                  }
                }
              });

            } catch (e) {
              alert('Error: ' + e.message);
              btn.disabled = false;
              btn.innerText = '💳 Pay &pound;${grandTotal.toFixed(2)} with Card';
            }
          }

          async function requestBACS() {
            const leader = validateLeader();
            if (!leader) return;

            const btn = document.querySelector('.btn-bacs');
            btn.disabled = true;
            btn.innerText = 'Submitting order...';

            await notifyServer('AWAITING BACS PAYMENT', leader);
            alert('🏛️ Order submitted! An invoice has been recorded and the picking slip emailed to the Badge Secretary.');
            window.location.reload();
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(`<h3>Server Error</h3><pre>${err.message}</pre>`);
  }
};