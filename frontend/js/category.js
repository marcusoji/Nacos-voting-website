// frontend/js/category.js
// Loaded by categories.html. Uses globals from app.js (apiFetch, Toast, Cart, VoteModal).
// NOT an ES module — no import/export.

document.addEventListener('DOMContentLoaded', async () => {
  const ICONS = {
    entrepreneur: '🚀',
    'freshman-male': '⭐',
    'freshman-female': '💎',
    'creator-male': '🎬',
    'creator-female': '✨'
  };

  const grid = document.getElementById('cat-grid');
  if (!grid) return;

  try {
    const r = await apiFetch('/voting/categories');
    if (r.ok && r.data.data && r.data.data.length) {
      grid.innerHTML = r.data.data.map(cat => `
        <a href="${cat.slug}.html" class="cat-card">
          <span class="cat-icon">${ICONS[cat.slug] || '🏆'}</span>
          <div class="cat-name">${cat.name}</div>
          <div class="cat-desc">${cat.description || ''}</div>
          <div class="cat-arrow">View nominees →</div>
        </a>`).join('');
    } else {
      grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);">No categories available yet.</p>';
    }
  } catch(e) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--crimson);">Failed to load. Please refresh.</p>';
  }
});