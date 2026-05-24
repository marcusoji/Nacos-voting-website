# NACOS Awards 2026 — Deployment Guide

Complete setup for Supabase · Resend · Paystack · Vercel.

---

## File Placement Guide

After unzipping, place edited files like this:

```
NACOS VOTING SYSTEM/
├── backend/
│   ├── .env.example          ← from output/
│   ├── package.json          ← from output/
│   ├── controllers/
│   │   ├── adminController.js  ← from output/
│   │   └── authController.js   ← from output/
│   └── routes/
│       └── adminRoutes.js      ← from output/
└── frontend/
    ├── app.js                ← from output/  (replaces root app.js)
    ├── style/
    │   └── main.css          ← from output/
    ├── index.html            ← from output/
    ├── login.html            ← from output/
    ├── register.html         ← from output/
    ├── forgot-password.html  ← from output/
    ├── reset-password.html   ← from output/
    ├── categories.html       ← from output/
    ├── entrepreneur.html     ← from output/
    ├── freshman-male.html    ← from output/  (copy of entrepreneur.html)
    ├── freshman-female.html  ← from output/
    ├── creator-male.html     ← from output/
    ├── creator-female.html   ← from output/
    ├── leaderboard.html      ← from output/
    ├── checkout.html         ← from output/
    ├── payment-success.html  ← from output/
    ├── admin-dashboard.html  ← from output/
    └── moderator-dashboard.html ← from output/
```

Add your logo files:
```
frontend/assets/delsu-logo.png
frontend/assets/nacos-logo.png
```

---

## Step 1 — Supabase Setup

### 1.1 Create Project
1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Choose a name (e.g. `nacos-awards`), set a strong DB password, pick closest region
3. Wait ~2 minutes for provisioning

### 1.2 Run the Database Schema
1. In your project: **SQL Editor** → **New Query**
2. Paste the entire contents of `backend/sql/codeforsql.sql`
3. Click **Run** — this creates all tables, RLS policies, functions, and seeds categories

### 1.3 Create Storage Bucket
1. Go to **Storage** → **New Bucket**
2. Name it exactly: `contestants`
3. Toggle **Public bucket** ON
4. Click **Save**

Then add upload policy — in the SQL Editor run:
```sql
CREATE POLICY "Allow authenticated uploads"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'contestants');

CREATE POLICY "Allow service role uploads"
ON storage.objects FOR INSERT
TO service_role
WITH CHECK (bucket_id = 'contestants');

CREATE POLICY "Public read contestants"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'contestants');
```

### 1.4 Get Your Keys
Go to **Project Settings** → **API**:

| Key | Where to use |
|-----|-------------|
| **Project URL** | `SUPABASE_URL` in backend `.env` AND `window.SUPABASE_URL` in `frontend/app.js` |
| **anon / public key** | `window.SUPABASE_ANON_KEY` in `frontend/app.js` |
| **service_role key** | `SUPABASE_SERVICE_ROLE_KEY` in backend `.env` only — never expose this |

### 1.5 Create Admin Account
1. **Authentication** → **Users** → **Add User**
2. Email: `admin@yourdomain.com`, set a strong password
3. After creating, run in SQL Editor:
```sql
UPDATE profiles SET role = 'admin' WHERE email = 'admin@yourdomain.com';
```

### 1.6 Enable Email Auth
**Authentication** → **Providers** → **Email** → toggle ON  
For forgot password emails to work, set your **Site URL** to your Vercel frontend URL.

---

## Step 2 — Resend Setup (Password Reset Emails)

1. Go to [resend.com](https://resend.com) → Sign up free
2. **Domains** → Add your domain (or use Resend's shared domain for testing)
3. Add the DNS records shown to your domain registrar (Namecheap, GoDaddy, etc.)
4. **API Keys** → **Create API Key** → copy it
5. Add to backend `.env`:
```
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=noreply@yourdomain.com
```

> **Without Resend:** The system still works — reset URLs are logged to the Vercel console instead of emailed. You can manually share them during testing.

---

## Step 3 — Paystack Setup

1. Go to [paystack.com](https://paystack.com) → Sign up / Log in
2. **Settings** → **API Keys & Webhooks**
3. Copy your **Secret Key** (use Test key first, Live key for production)
4. Add to backend `.env`:
```
PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxx
```

### Webhook Configuration
Still in Paystack Settings → **API Keys & Webhooks** → **Webhooks**:
- URL: `https://YOUR-BACKEND.vercel.app/api/voting/webhook`
- Events to listen for: `charge.success`
- Click **Save**

> Webhooks ensure votes are recorded even if the user closes their browser after paying.

---

## Step 4 — Deploy Backend to Vercel

### 4.1 Prepare
```bash
cd "NACOS VOTING SYSTEM/backend"
npm install
```

### 4.2 Deploy via Vercel CLI
```bash
npm install -g vercel
vercel login
vercel --prod
```

When prompted:
- Set up and deploy? **Y**
- Which scope? Select your account
- Link to existing project? **N**
- Project name: `nacos-voting-api`
- Directory: `./` (already in backend folder)
- Override settings? **N**

### 4.3 Add Environment Variables
In [vercel.com](https://vercel.com) → your project → **Settings** → **Environment Variables**, add:

```
SUPABASE_URL               = https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY  = eyJhbGciOiJIUzI1NiIs...
PAYSTACK_SECRET_KEY        = sk_live_xxxxx
RESEND_API_KEY             = re_xxxxx
RESEND_FROM_EMAIL          = noreply@yourdomain.com
COOKIE_SECRET              = (generate: openssl rand -hex 32)
JWT_SECRET                 = (generate: openssl rand -hex 32)
NODE_ENV                   = production
FRONTEND_URL               = https://your-frontend.vercel.app
```

> Apply to **Production**, **Preview**, and **Development** environments.

### 4.4 Redeploy
```bash
vercel --prod
```

Note your backend URL: `https://nacos-voting-api.vercel.app`

---

## Step 5 — Deploy Frontend to Vercel

### 5.1 Update API URLs
In `frontend/app.js`, update line 4:
```js
const _PROD_API = 'https://nacos-voting-api.vercel.app/api'; // ← your backend URL
```

Also update the Supabase config (lines 9–10):
```js
window.SUPABASE_URL      = 'https://YOUR_PROJECT_ID.supabase.co';
window.SUPABASE_ANON_KEY = 'your-anon-key-here';
```

### 5.2 Deploy
```bash
cd "NACOS VOTING SYSTEM/frontend"
vercel --prod
```

When prompted:
- Project name: `nacos-voting-frontend`
- Framework: **Other**
- Root directory: `./`

### 5.3 Update Backend CORS
Back in Vercel backend settings, update `FRONTEND_URL`:
```
FRONTEND_URL = https://nacos-voting-frontend.vercel.app
```
Then redeploy backend: `vercel --prod`

### 5.4 Update Supabase Site URL
**Supabase** → **Authentication** → **URL Configuration** → **Site URL**:
```
https://nacos-voting-frontend.vercel.app
```

---

## Step 6 — Final Checks

### Test Checklist
- [ ] Open frontend URL in browser
- [ ] Register a new voter account
- [ ] Check email for verification (Supabase sends this automatically)
- [ ] Log in with matric number
- [ ] Browse categories and click Vote
- [ ] Complete a Paystack test payment (use card `4084084084084081`, any future date, CVV `408`)
- [ ] Verify vote appears in leaderboard
- [ ] Log in as admin → dashboard loads analytics
- [ ] Upload a contestant photo → image appears in Supabase Storage
- [ ] Test forgot password flow

### Generate Secure Secrets (run in terminal)
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Run twice — one for `COOKIE_SECRET`, one for `JWT_SECRET`.

---

## Common Issues

| Problem | Fix |
|---------|-----|
| CORS error in browser | Add frontend URL to `FRONTEND_URL` env var and redeploy backend |
| Cookies not sent | Backend must be on HTTPS; `sameSite: 'none'` requires `secure: true` |
| Image upload fails | Check Supabase Storage bucket is named exactly `contestants` and policies are set |
| Webhook not firing | Verify Paystack webhook URL uses your actual backend domain, not localhost |
| Admin login redirects to login | Run SQL to set role: `UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com'` |
| Password reset email not arriving | Check `RESEND_API_KEY` is set; check Resend dashboard for delivery logs |

---

## Local Development

```bash
# Backend
cd backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # runs on http://localhost:5000

# Frontend — just open with Live Server (VS Code extension)
# or: npx serve frontend
```

Set `FRONTEND_URL=http://localhost:3000,http://127.0.0.1:5500` in backend `.env` for local CORS.

---

## Architecture Summary

```
Browser (Vercel static)
  └─ app.js / main.css / HTML pages
       │
       ├── apiFetch()  ──────────────────► Vercel Serverless (backend)
       │                                     └── Express → Supabase DB
       │
       ├── Image upload ─────────────────► Supabase Storage (direct from browser)
       │
       └── Payment ──────────────────────► Paystack
                                              └── Webhook → backend → DB vote recorded
```

---

*Built for DELSU NACOS Awards 2026*
