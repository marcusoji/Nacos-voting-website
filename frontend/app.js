// frontend/app.js — shared utilities (non-module, global scope)

// ── Config ────────────────────────────────────────────────────
const _PROD_API = 'https://nacos-voting-website.vercel.app/api';
const _isDev    = ['localhost', '127.0.0.1', ''].includes(location.hostname);
window.API      = _isDev ? 'http://localhost:5000/api' : _PROD_API;
window.PRICE    = 100;

// ── SVG icons ─────────────────────────────────────────────────
const SVG = {
  ballot: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  trash : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>`,
  check : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
  cross : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  info  : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  warn  : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
};

// ── Route Guard ───────────────────────────────────────────────
const PUBLIC_PAGES = new Set([
  '', 'index.html', 'login.html', 'register.html',
  'forgot-password.html', 'reset-password.html',
  'leaderboard.html', 'categories.html', 'payment-success.html',
  'entrepreneur.html', 'freshman-male.html', 'freshman-female.html',
  'creator-male.html', 'creator-female.html'
]);
const ADMIN_PAGES = new Set(['admin-dashboard.html']);
const STAFF_PAGES = new Set(['moderator-dashboard.html']);

(function routeGuard() {
  const page = location.pathname.split('/').pop() || 'index.html';
  let user = null;
  try { user = JSON.parse(localStorage.getItem('nacos_user')); } catch {}
  if (!PUBLIC_PAGES.has(page) && !user)                                      { location.replace('login.html'); return; }
  if (ADMIN_PAGES.has(page) && user?.role !== 'admin')                       { location.replace('login.html'); return; }
  if (STAFF_PAGES.has(page) && !['admin','moderator'].includes(user?.role))  { location.replace('login.html'); return; }
  if (page === 'checkout.html' && !user)                                      { location.replace('login.html'); return; }
})();

// ── Fetch helper — always sends Bearer token ──────────────────
window.apiFetch = async (path, opts = {}) => {
  try {
    const token = localStorage.getItem('nacos_token');
    const res = await fetch(`${window.API}${path}`, {
      ...opts,
      headers: {
        'Content-Type' : 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(opts.headers || {})
      }
      // NOTE: no 'credentials' needed — we use Bearer token, not cookies
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('[apiFetch] Network error on', path, err.message);
    return { ok: false, status: 0, data: { message: 'Network error. Check your connection.' } };
  }
};

// ── Loading helper ────────────────────────────────────────────
window.setLoading = (btn, loading, original = 'Submit') => {
  if (!btn) return;
  if (loading) {
    btn.disabled     = true;
    btn.dataset.orig = btn.innerHTML;
    btn.innerHTML    = `<span class="spinner"></span> Processing…`;
  } else {
    btn.disabled  = false;
    btn.innerHTML = btn.dataset.orig || original;
  }
};

// ── Toast ─────────────────────────────────────────────────────
window.Toast = {
  show(title, msg = '', type = 'info') {
    let c = document.getElementById('toasts');
    if (!c) { c = document.createElement('div'); c.id = 'toasts'; document.body.appendChild(c); }
    const icons = { success: SVG.check, error: SVG.cross, info: SVG.info, warning: SVG.warn };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `
      <span class="t-icon">${icons[type] || icons.info}</span>
      <div class="t-body">
        <div class="t-title">${title}</div>
        ${msg ? `<div class="t-msg">${msg}</div>` : ''}
      </div>`;
    c.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 320); }, 4200);
  },
  success(t, m) { this.show(t, m, 'success'); },
  error(t, m)   { this.show(t, m, 'error');   },
  info(t, m)    { this.show(t, m, 'info');     },
  warning(t, m) { this.show(t, m, 'warning');  }
};

// ── Auth ──────────────────────────────────────────────────────
window.Auth = {
  _userKey : 'nacos_user',
  _tokenKey: 'nacos_token',

  getUser()    { try { return JSON.parse(localStorage.getItem(this._userKey)); } catch { return null; } },
  getToken()   { return localStorage.getItem(this._tokenKey) || null; },
  setUser(u)   { localStorage.setItem(this._userKey, JSON.stringify(u)); },
  setToken(t)  { if (t) localStorage.setItem(this._tokenKey, t); },
  clear()      { localStorage.removeItem(this._userKey); localStorage.removeItem(this._tokenKey); },
  isLoggedIn() { return !!(this.getUser() && this.getToken()); },
  role()       { return this.getUser()?.role || 'user'; },

  async checkSession() {
    const token = this.getToken();
    if (!token) return null;
    try {
      const res = await fetch(`${window.API}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const d = await res.json();
        this.setUser(d.user);
        return d.user;
      }
      // Token invalid — clear on protected pages only
      const page = location.pathname.split('/').pop() || 'index.html';
      this.clear();
      if (!PUBLIC_PAGES.has(page)) location.replace('login.html');
      return null;
    } catch { return null; }
  },

  async logout() {
    try {
      const token = this.getToken();
      if (token) {
        await fetch(`${window.API}/auth/logout`, {
          method : 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      }
    } catch {}
    this.clear();
    Cart.clear();
    location.href = 'login.html';
  }
};

// ── Cart ──────────────────────────────────────────────────────
window.Cart = {
  _key: 'nacos_cart',
  get()       { try { return JSON.parse(localStorage.getItem(this._key)) || []; } catch { return []; } },
  save(items) { localStorage.setItem(this._key, JSON.stringify(items)); this.updateBadge(); if (window._cartSidebar) window._cartSidebar.render(); },
  clear()     { localStorage.removeItem(this._key); this.updateBadge(); if (window._cartSidebar) window._cartSidebar.render(); },
  count()     { return this.get().reduce((s, i) => s + i.quantity, 0); },
  total()     { return this.get().reduce((s, i) => s + i.quantity * PRICE, 0); },
  add(item) {
    const items = this.get();
    const ex    = items.find(i => i.contestantId === item.contestantId);
    if (ex) ex.quantity = Math.min(1000, ex.quantity + (item.quantity || 1));
    else    items.push({ ...item, quantity: item.quantity || 1 });
    this.save(items);
    Toast.success('Added to ballot', item.name);
  },
  removeById(id) { this.save(this.get().filter(i => i.contestantId !== id)); },
  updateQty(id, delta) {
    const items = this.get(), item = items.find(i => i.contestantId === id);
    if (!item) return;
    item.quantity = Math.max(1, Math.min(1000, item.quantity + delta));
    this.save(items);
  },
  updateBadge() {
    const n = this.get().length;
    document.querySelectorAll('.cart-badge').forEach(b => { b.textContent = n; b.classList.toggle('hidden', n === 0); });
  }
};

// ── Navbar ────────────────────────────────────────────────────
function buildNavbar() {
  const user = Auth.getUser();
  const page = location.pathname.split('/').pop() || 'index.html';
  const links = [
    { href: 'index.html',       label: 'Home' },
    { href: 'categories.html',  label: 'Vote' },
    { href: 'leaderboard.html', label: 'Leaderboard' }
  ];
  if (user?.role === 'admin')     links.push({ href: 'admin-dashboard.html',     label: 'Dashboard' });
  if (user?.role === 'moderator') links.push({ href: 'moderator-dashboard.html', label: 'Dashboard' });

  const nav = document.createElement('nav');
  nav.className = 'navbar'; nav.id = 'main-navbar';
  nav.innerHTML = `
    <a href="index.html" class="nav-brand">
      <div class="logo-cluster">
        <img src="assets/delsu-logo.png" alt="DELSU" onerror="this.style.display='none'">
        <img src="assets/nacos-logo.png"  alt="NACOS" onerror="this.style.display='none'">
      </div>
      NACOS <span>Awards</span>
    </a>
    <div class="nav-links">
      ${links.map(l => `<a href="${l.href}" class="${page === l.href ? 'active' : ''}">${l.label}</a>`).join('')}
    </div>
    <div class="nav-right">
      <button class="nav-cart" onclick="CartSidebar.toggle()" title="Your ballot" aria-label="Open ballot">
        ${SVG.ballot}<span class="cart-badge hidden">0</span>
      </button>
      ${user
        ? `<span class="nav-username">${user.fullname?.split(' ')[0] || 'User'}</span>
           <button class="btn btn-ghost btn-sm" onclick="Auth.logout()">Logout</button>`
        : `<a href="login.html"    class="btn btn-outline btn-sm">Login</a>
           <a href="register.html" class="btn btn-primary btn-sm">Register</a>`
      }
      <button class="hamburger" id="hamburger" onclick="toggleMobileNav()">
        <span></span><span></span><span></span>
      </button>
    </div>`;

  const mob = document.createElement('div');
  mob.className = 'mobile-nav'; mob.id = 'mobile-nav';
  mob.innerHTML = links.map(l => `<a href="${l.href}">${l.label}</a>`).join('') +
    (user
      ? `<button class="btn btn-ghost btn-sm" style="margin-top:8px;width:100%;" onclick="Auth.logout()">Logout</button>`
      : `<a href="login.html">Login</a><a href="register.html">Register</a>`);

  document.body.prepend(mob);
  document.body.prepend(nav);
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 20));
  Cart.updateBadge();
}

function toggleMobileNav() {
  document.getElementById('mobile-nav')?.classList.toggle('open');
  document.getElementById('hamburger')?.classList.toggle('open');
}

// ── Cart Sidebar ──────────────────────────────────────────────
window.CartSidebar = {
  el: null, overlay: null,
  init() {
    const s = document.createElement('div');
    s.className = 'cart-sidebar'; s.id = 'cart-sidebar';
    s.innerHTML = `
      <div class="cart-head">
        <div class="cart-head-title">Your Ballot</div>
        <button class="cart-x" onclick="CartSidebar.close()" aria-label="Close">&#10005;</button>
      </div>
      <div class="cart-items" id="cart-items-list"></div>
      <div class="cart-foot" id="cart-foot">
        <div class="cart-total">
          <span class="cart-total-lbl">Total</span>
          <span class="cart-total-amt" id="cart-total-amt">&#8358;0</span>
        </div>
        <a href="checkout.html" class="btn btn-gold btn-full">Proceed to Checkout</a>
        <button class="btn btn-ghost btn-full mt-8" onclick="CartSidebar.close()">Continue Voting</button>
      </div>`;
    document.body.appendChild(s); this.el = s;
    const o = document.createElement('div');
    o.className = 'cart-overlay'; o.onclick = () => this.close();
    document.body.appendChild(o); this.overlay = o;
    window._cartSidebar = this; this.render();
  },
  toggle() { this.el?.classList.contains('open') ? this.close() : this.open(); },
  open()   { this.render(); this.el?.classList.add('open'); this.overlay?.classList.add('open'); document.body.style.overflow = 'hidden'; },
  close()  { this.el?.classList.remove('open'); this.overlay?.classList.remove('open'); document.body.style.overflow = ''; },
  render() {
    const items = Cart.get();
    const list  = document.getElementById('cart-items-list');
    const foot  = document.getElementById('cart-foot');
    const tot   = document.getElementById('cart-total-amt');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">${SVG.ballot}</div><p>Your ballot is empty</p><p class="text-muted" style="font-size:.8rem;margin-top:.25rem;">Browse categories to add votes</p></div>`;
      if (foot) foot.style.display = 'none'; return;
    }
    if (foot) foot.style.display = 'block';
    if (tot)  tot.textContent = `\u20A6${Cart.total().toLocaleString()}`;
    list.innerHTML = items.map(item => `
      <div class="cart-item" data-id="${item.contestantId}">
        <div class="cart-item-top">
          <div class="cart-item-ava">
            ${item.avatarUrl ? `<img src="${item.avatarUrl}" alt="" onerror="this.style.display='none'">` : ''}
            <span class="avatar-initial">${item.name.charAt(0).toUpperCase()}</span>
          </div>
          <div style="flex:1;min-width:0;">
            <div class="cart-item-name">${item.name}</div>
            <div class="cart-item-cat">${item.category}</div>
          </div>
          <span class="cart-item-del" onclick="Cart.removeById('${item.contestantId}')" title="Remove" role="button">${SVG.trash}</span>
        </div>
        <div class="cart-item-bottom">
          <div class="cart-qty-row">
            <div class="cqb" onclick="Cart.updateQty('${item.contestantId}',-1)">&#8722;</div>
            <div class="cqv">${item.quantity}</div>
            <div class="cqb" onclick="Cart.updateQty('${item.contestantId}',1)">&#43;</div>
          </div>
          <span class="cart-item-price">&#8358;${(item.quantity * PRICE).toLocaleString()}</span>
        </div>
      </div>`).join('');
  }
};

// ── Vote Modal ────────────────────────────────────────────────
window.VoteModal = {
  el: null, current: null, qty: 1,
  init() {
    const m = document.createElement('div');
    m.className = 'modal-overlay'; m.id = 'vote-modal';
    m.innerHTML = `
      <div class="modal-box">
        <button class="modal-close" onclick="VoteModal.close()" aria-label="Close">&#10005;</button>
        <div style="text-align:center;margin-bottom:20px;">
          <div id="vm-avatar" class="modal-avatar-wrap"></div>
          <div id="vm-name" class="font-display fw-700" style="font-size:1.15rem;margin-bottom:2px;"></div>
          <div id="vm-cat"  class="text-muted" style="font-size:.82rem;"></div>
        </div>
        <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:18px;">
          <div class="text-muted mb-8" style="font-size:.8rem;text-align:center;">Number of votes</div>
          <div class="qty-row" style="justify-content:center;margin-bottom:8px;">
            <button class="qty-btn" onclick="VoteModal.adjustQty(-1)">&#8722;</button>
            <div class="qty-val" id="vm-qty">1</div>
            <button class="qty-btn" onclick="VoteModal.adjustQty(1)">&#43;</button>
          </div>
          <div class="price-tag" id="vm-price">&#8358;100</div>
          <div class="price-note">&#8358;100 per vote &middot; Max 1,000</div>
        </div>
        <button class="btn btn-gold btn-full btn-lg" onclick="VoteModal.addToCart()">Add to Ballot</button>
        <button class="btn btn-ghost btn-full mt-8" onclick="VoteModal.close()">Cancel</button>
      </div>`;
    m.addEventListener('click', e => { if (e.target === m) this.close(); });
    document.body.appendChild(m); this.el = m;
  },
  open(contestant) {
    this.current = contestant; this.qty = 1;
    document.getElementById('vm-name').textContent = contestant.name;
    document.getElementById('vm-cat').textContent  = contestant.category || '';
    const ava  = document.getElementById('vm-avatar');
    const init = contestant.name.charAt(0).toUpperCase();
    ava.innerHTML = contestant.avatarUrl
      ? `<img src="${contestant.avatarUrl}" alt="${contestant.name}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:2px solid var(--border-gold);"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="avatar-initial-lg" style="display:none">${init}</div>`
      : `<div class="avatar-initial-lg">${init}</div>`;
    this._update();
    this.el.classList.add('open'); document.body.style.overflow = 'hidden';
  },
  close()      { this.el?.classList.remove('open'); document.body.style.overflow = ''; },
  adjustQty(d) { this.qty = Math.max(1, Math.min(1000, this.qty + d)); this._update(); },
  _update() {
    document.getElementById('vm-qty').textContent   = this.qty;
    document.getElementById('vm-price').textContent = `\u20A6${(this.qty * PRICE).toLocaleString()}`;
  },
  addToCart() {
    if (!this.current) return;
    Cart.add({ ...this.current, contestantId: this.current.id, quantity: this.qty });
    this.close(); setTimeout(() => CartSidebar.open(), 300);
  }
};

// ── Counters ──────────────────────────────────────────────────
function initCounters() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return; obs.disconnect();
      let v = 0; const step = target / (1500/16);
      const id = setInterval(() => {
        v += step;
        if (v >= target) { el.textContent = target.toLocaleString(); clearInterval(id); }
        else el.textContent = Math.floor(v).toLocaleString();
      }, 16);
    });
    obs.observe(el);
  });
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildNavbar();
  CartSidebar.init();
  VoteModal.init();
  initCounters();
  Auth.checkSession();
});
