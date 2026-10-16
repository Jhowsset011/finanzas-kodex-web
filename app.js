/* Finanzas KODEX — sellers web app (static, Supabase JS v2) */
'use strict';

/* ================= Config ================= */
const SUPABASE_URL = 'https://ltvpjaqafyggenpdbekl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_WCyNNOLe4jegZGRbJ6oNPQ_1aBy7mWz'; // <-- reemplazar antes de publicar
const LOGIN_DOMAIN = '@finanzas.kodex';

let sb = null;
let profile = null;          // {id, name, username, role}
let productsCache = [];      // [{id,name,reference,category,cost_dop}]
let sellersCache = [];       // owner only: [{id,name,username,role}]
let selectedProduct = null;
let currentTab = null;

/* ================= Helpers ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtMoney = n => new Intl.NumberFormat('es-DO', {
  style: 'currency', currency: 'DOP',
  minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(Number(n) || 0);

const fmtDate = iso => {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: 'numeric' });
};

const todayISO = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
};

const monthLabel = ym => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
};
const shiftMonth = (ym, delta) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
const monthRange = ym => {
  const from = ym + '-01';
  const to = shiftMonth(ym, 1) + '-01';
  return { from, to };
};

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function dbError(err, fallback) {
  console.error(err);
  if (!navigator.onLine) return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
  const m = (err && err.message) || '';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Sin conexión con el servidor. Revisa tu internet.';
  return fallback || 'Ocurrió un error. Inténtalo de nuevo.';
}

/* Profit math (single source of truth):
   margin      = qty*price - qty*cost - shipping
   sellerShare = margin / 2            (Víctor / Ana)
   ownerNet    = sellerShare - adPortion   (dueño, sobre venta de vendedor)
   ownerNet    = margin - adPortion         (dueño, venta propia)
   adPortion   = ad_spend[date] / nº de ventas de ese día (todas) */
const saleMargin = (s, cost) =>
  (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0) -
  (Number(s.quantity) || 0) * (Number(cost) || 0) -
  (Number(s.shipping_cost_dop) || 0);

/* ================= Auth ================= */
async function handleLogin(e) {
  e.preventDefault();
  const errBox = $('login-error');
  errBox.classList.add('hidden');
  const username = $('login-user').value.trim().toLowerCase();
  const password = $('login-pass').value;
  if (!username || !password) {
    errBox.textContent = 'Escribe tu usuario y tu contraseña.';
    errBox.classList.remove('hidden');
    return;
  }
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const email = username + LOGIN_DOMAIN;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const user = data.user;
    const { data: prof, error: pErr } = await sb.from('sellers')
      .select('id,name,username,role').eq('auth_user_id', user.id).single();
    if (pErr || !prof) {
      await sb.auth.signOut();
      throw new Error('profile-missing');
    }
    profile = prof;
    await enterApp();
  } catch (err) {
    console.error(err);
    errBox.textContent = err.message === 'profile-missing'
      ? 'Tu cuenta no tiene un perfil asignado. Habla con Jhowsse.'
      : 'Usuario o contraseña incorrectos.';
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function restoreSession() {
  const { data } = await sb.auth.getSession();
  const user = data.session && data.session.user;
  if (!user) return false;
  const { data: prof, error } = await sb.from('sellers')
    .select('id,name,username,role').eq('auth_user_id', user.id).single();
  if (error || !prof) { await sb.auth.signOut(); return false; }
  profile = prof;
  return true;
}

async function logout() {
  await sb.auth.signOut();
  profile = null;
  productsCache = [];
  sellersCache = [];
  selectedProduct = null;
  $('login-pass').value = '';
  $('view-main').classList.add('hidden');
  $('view-login').classList.remove('hidden');
}

/* ================= Navigation ================= */
const SELLER_TABS = [
  { id: 'registrar', label: 'Registrar', icon: '＋' },
  { id: 'misventas', label: 'Mis ventas', icon: '▤' },
  { id: 'resumen',    label: 'Resumen',   icon: '◔' },
];
const OWNER_TABS = [
  { id: 'ventas',     label: 'Ventas',     icon: '▤' },
  { id: 'vendedores', label: 'Vendedores', icon: '◯' },
  { id: 'publicidad', label: 'Publicidad', icon: '◈' },
  { id: 'productos',  label: 'Productos',  icon: '▦' },
];

function buildNav() {
  const tabs = profile.role === 'owner' ? OWNER_TABS : SELLER_TABS;
  const nav = $('bottomnav');
  nav.innerHTML = '';
  tabs.forEach(t => {
    const b = document.createElement('button');
    b.innerHTML = '<span class="ico">' + t.icon + '</span>' + esc(t.label);
    b.onclick = () => switchTab(t.id);
    b.dataset.tab = t.id;
    nav.appendChild(b);
  });
  switchTab(tabs[0].id);
}

function switchTab(id) {
  currentTab = id;
  document.querySelectorAll('.tab').forEach(s => s.classList.add('hidden'));
  $('tab-' + id).classList.remove('hidden');
  document.querySelectorAll('#bottomnav button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === id));
  if (id === 'registrar') initSaleForm();
  if (id === 'misventas') loadMySales();
  if (id === 'resumen') loadMySummary();
  if (id === 'ventas') loadOwnerSales();
  if (id === 'vendedores') loadSellersSummary();
  if (id === 'publicidad') initAdForm();
  if (id === 'productos') loadProducts();
}

async function enterApp() {
  $('user-name').textContent = profile.name;
  $('user-role').textContent = profile.role === 'owner' ? 'Dueño' : 'Vendedor';
  $('view-login').classList.add('hidden');
  $('view-main').classList.remove('hidden');
  try {
    await loadProductsCache();
    if (profile.role === 'owner') await loadSellersCache();
  } catch (err) {
    toast(dbError(err, 'No se pudo cargar el catálogo.'), true);
  }
  buildNav();
}

/* ================= Shared data ================= */
async function loadProductsCache() {
  const { data, error } = await sb.from('products')
    .select('id,name,reference,category,cost_dop').order('name');
  if (error) throw error;
  productsCache = data || [];
}
async function loadSellersCache() {
  const { data, error } = await sb.from('sellers').select('id,name,username,role');
  if (error) throw error;
  sellersCache = data || [];
}
const productById = id => productsCache.find(p => String(p.id) === String(id));
const sellerById = id => sellersCache.find(s => s.id === id);
const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/* ================= Seller: register sale ================= */
function initSaleForm() {
  if (!$('sale-date').value) $('sale-date').value = todayISO();
  updatePreview();
}

function bindSaleForm() {
  const search = $('sale-product-search');
  const results = $('product-results');
  search.addEventListener('input', () => {
    const q = norm(search.value.trim());
    if (q.length < 2) { results.classList.add('hidden'); return; }
    const matches = productsCache.filter(p =>
      norm(p.name).includes(q) || norm(p.reference).includes(q)).slice(0, 8);
    if (!matches.length) { results.classList.add('hidden'); return; }
    results.innerHTML = matches.map(p =>
      '<div class="opt" data-id="' + p.id + '">' + esc(p.name) +
      '<small>' + esc(p.reference || '') + ' · ' + fmtMoney(p.cost_dop) + '</small></div>'
    ).join('');
    results.classList.remove('hidden');
    results.querySelectorAll('.opt').forEach(o => o.onclick = () => selectProduct(o.dataset.id));
  });
  document.addEventListener('click', e => {
    if (!results.contains(e.target) && e.target !== search) results.classList.add('hidden');
  });
  $('product-clear').onclick = () => {
    selectedProduct = null;
    search.value = '';
    $('product-selected').classList.add('hidden');
    search.classList.remove('hidden');
    search.focus();
    updatePreview();
  };
  ['sale-qty', 'sale-price', 'sale-ship'].forEach(id =>
    $(id).addEventListener('input', updatePreview));
  $('sale-save').onclick = saveSale;
}

function selectProduct(id) {
  selectedProduct = productById(id);
  if (!selectedProduct) return;
  $('product-results').classList.add('hidden');
  $('sale-product-search').classList.add('hidden');
  $('sp-name').textContent = selectedProduct.name;
  $('sp-cost').textContent = fmtMoney(selectedProduct.cost_dop);
  $('product-selected').classList.remove('hidden');
  updatePreview();
}

function readSaleForm() {
  return {
    qty: Math.max(1, parseInt($('sale-qty').value, 10) || 1),
    price: Number($('sale-price').value) || 0,
    ship: Math.max(0, Number($('sale-ship').value) || 0),
    date: $('sale-date').value || todayISO(),
    desc: $('sale-desc').value.trim().slice(0, 200),
  };
}

function updatePreview() {
  const v = $('sale-preview-value');
  if (!selectedProduct) { v.textContent = '—'; v.classList.remove('neg'); return; }
  const f = readSaleForm();
  const margin = f.qty * f.price - f.qty * Number(selectedProduct.cost_dop) - f.ship;
  const share = margin / 2;
  v.textContent = fmtMoney(share);
  v.classList.toggle('neg', share < 0);
}

async function saveSale() {
  const errBox = $('sale-error');
  errBox.classList.add('hidden');
  if (!selectedProduct) {
    errBox.textContent = 'Busca y elige un producto primero.';
    errBox.classList.remove('hidden');
    return;
  }
  const f = readSaleForm();
  if (f.price <= 0) {
    errBox.textContent = 'Escribe el precio de venta.';
    errBox.classList.remove('hidden');
    return;
  }
  const btn = $('sale-save');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    const { error } = await sb.from('sales').insert({
      seller_id: profile.id,           // siempre el vendedor logueado
      product_id: selectedProduct.id,
      quantity: f.qty,
      unit_sale_price_dop: f.price,
      shipping_cost_dop: f.ship,
      sale_date: f.date,
      description: f.desc,
    });
    if (error) throw error;
    toast('Venta registrada.');
    // limpiar
    $('product-clear').onclick();
    $('sale-qty').value = '1';
    $('sale-price').value = '';
    $('sale-ship').value = '0';
    $('sale-desc').value = '';
    updatePreview();
  } catch (err) {
    errBox.textContent = dbError(err, 'No se pudo guardar la venta.');
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar venta';
  }
}

/* ================= Seller: my sales + summary ================= */
const mySalesMonth = { ym: todayISO().slice(0, 7) };

async function loadMySales() {
  const list = $('my-sales-list');
  $('mv-month-label').textContent = monthLabel(mySalesMonth.ym);
  list.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const { from, to } = monthRange(mySalesMonth.ym);
    const { data, error } = await sb.from('sales').select('*')
      .eq('seller_id', profile.id)
      .gte('sale_date', from).lt('sale_date', to)
      .order('sale_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || !data.length) {
      list.innerHTML = '<div class="empty">No hay ventas este mes.</div>';
      return;
    }
    list.innerHTML = data.map(s => {
      const p = productById(s.product_id);
      const share = saleMargin(s, p && p.cost_dop) / 2;
      return '<div class="item">' +
        '<div class="item-head"><span class="item-title">' + esc(p ? p.name : 'Producto') + '</span>' +
        '<span class="item-date">' + fmtDate(s.sale_date) + '</span></div>' +
        '<div class="item-rows">' +
        '<span>Cantidad: <b>' + s.quantity + '</b></span>' +
        '<span>Precio: <b>' + fmtMoney(s.unit_sale_price_dop) + '</b></span>' +
        '<span>Envío: <b>' + fmtMoney(s.shipping_cost_dop) + '</b></span>' +
        '<span>Mi parte: <b class="share' + (share < 0 ? ' neg' : '') + '">' + fmtMoney(share) + '</b></span>' +
        '</div>' +
        (s.description ? '<div class="muted">' + esc(s.description) + '</div>' : '') +
        '</div>';
    }).join('');
  } catch (err) {
    list.innerHTML = '<div class="empty">' + esc(dbError(err)) + '</div>';
  }
}

const mySummaryMonth = { ym: todayISO().slice(0, 7) };

async function loadMySummary() {
  $('rs-month-label').textContent = monthLabel(mySummaryMonth.ym);
  try {
    const { from, to } = monthRange(mySummaryMonth.ym);
    const { data, error } = await sb.from('sales').select('*')
      .eq('seller_id', profile.id)
      .gte('sale_date', from).lt('sale_date', to);
    if (error) throw error;
    let total = 0, share = 0;
    (data || []).forEach(s => {
      const p = productById(s.product_id);
      total += (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0);
      share += saleMargin(s, p && p.cost_dop) / 2;
    });
    $('rs-total').textContent = fmtMoney(total);
    $('rs-share').textContent = fmtMoney(share);
    $('rs-share').classList.toggle('neg', share < 0);
    $('rs-count').textContent = (data || []).length;
  } catch (err) {
    toast(dbError(err), true);
  }
}

/* ================= Owner: sales dashboard ================= */
const ownerMonth = { ym: todayISO().slice(0, 7) };
let ownerData = { sales: [], ad: {} };

async function fetchOwnerMonth() {
  const { from, to } = monthRange(ownerMonth.ym);
  const [sRes, aRes] = await Promise.all([
    sb.from('sales').select('*').gte('sale_date', from).lt('sale_date', to)
      .order('sale_date', { ascending: false }).order('created_at', { ascending: false }),
    sb.from('ad_spend').select('*').gte('spend_date', from).lt('spend_date', to),
  ]);
  if (sRes.error) throw sRes.error;
  if (aRes.error) throw aRes.error;
  const ad = {};
  (aRes.data || []).forEach(r => { ad[r.spend_date] = Number(r.amount_dop) || 0; });
  ownerData = { sales: sRes.data || [], ad };
  return ownerData;
}

function adPortionMap(sales, ad) {
  const counts = {};
  sales.forEach(s => { counts[s.sale_date] = (counts[s.sale_date] || 0) + 1; });
  const map = {};
  Object.keys(counts).forEach(d => {
    map[d] = (ad[d] || 0) / counts[d];
  });
  return map;
}

function saleCalc(s, portion) {
  const p = productById(s.product_id);
  const seller = sellerById(s.seller_id);
  const cost = p ? Number(p.cost_dop) : 0;
  const margin = saleMargin(s, cost);
  const isOwner = seller && seller.role === 'owner';
  const sellerShare = isOwner ? 0 : margin / 2;
  const ownerNet = isOwner ? margin - portion : sellerShare - portion;
  return { p, seller, margin, sellerShare, ownerNet };
}

async function loadOwnerSales() {
  const list = $('owner-sales-list');
  $('ow-month-label').textContent = monthLabel(ownerMonth.ym);
  const filterSel = $('ow-seller-filter');
  if (!filterSel.dataset.ready) {
    sellersCache.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name + (s.role === 'owner' ? ' (dueño)' : '');
      filterSel.appendChild(o);
    });
    filterSel.dataset.ready = '1';
    filterSel.onchange = loadOwnerSales;
  }
  list.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const { sales, ad } = await fetchOwnerMonth();
    const portions = adPortionMap(sales, ad);
    const f = filterSel.value;
    const rows = f ? sales.filter(s => s.seller_id === f) : sales;
    if (!rows.length) {
      list.innerHTML = '<div class="empty">No hay ventas este mes.</div>';
      return;
    }
    list.innerHTML = rows.map(s => {
      const c = saleCalc(s, portions[s.sale_date] || 0);
      const badge = c.seller
        ? '<span class="badge ' + c.seller.role + '">' + esc(c.seller.name) + '</span>'
        : '<span class="badge">?</span>';
      return '<div class="item">' +
        '<div class="item-head"><span class="item-title">' + esc(c.p ? c.p.name : 'Producto') + '</span>' + badge + '</div>' +
        '<div class="item-date" style="margin-bottom:6px">' + fmtDate(s.sale_date) + '</div>' +
        '<div class="item-rows">' +
        '<span>Cant: <b>' + s.quantity + '</b></span>' +
        '<span>Precio: <b>' + fmtMoney(s.unit_sale_price_dop) + '</b></span>' +
        '<span>Envío: <b>' + fmtMoney(s.shipping_cost_dop) + '</b></span>' +
        '<span>Margen: <b class="' + (c.margin < 0 ? 'neg' : '') + '">' + fmtMoney(c.margin) + '</b></span>' +
        (c.seller && c.seller.role !== 'owner'
          ? '<span>Vendedor (50%): <b class="share' + (c.sellerShare < 0 ? ' neg' : '') + '">' + fmtMoney(c.sellerShare) + '</b></span>'
          : '') +
        '<span>Neto dueño: <b class="' + (c.ownerNet < 0 ? 'neg' : '') + '">' + fmtMoney(c.ownerNet) + '</b></span>' +
        '</div></div>';
    }).join('');
  } catch (err) {
    list.innerHTML = '<div class="empty">' + esc(dbError(err)) + '</div>';
  }
}

/* ================= Owner: sellers summary ================= */
const sellersMonth = { ym: todayISO().slice(0, 7) };

async function loadSellersSummary() {
  $('sl-month-label').textContent = monthLabel(sellersMonth.ym);
  const box = $('sellers-summary');
  box.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const saved = ownerMonth.ym;
    ownerMonth.ym = sellersMonth.ym;
    const { sales, ad } = await fetchOwnerMonth();
    ownerMonth.ym = saved;
    const portions = adPortionMap(sales, ad);
    const per = {};
    let adTotal = 0, ownerNetTotal = 0;
    Object.values(ad).forEach(v => { adTotal += v; });
    sales.forEach(s => {
      const c = saleCalc(s, portions[s.sale_date] || 0);
      const key = s.seller_id;
      if (!per[key]) per[key] = { name: c.seller ? c.seller.name : '?', role: c.seller ? c.seller.role : '', count: 0, sold: 0, share: 0, net: 0 };
      per[key].count++;
      per[key].sold += (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0);
      per[key].share += c.sellerShare;
      per[key].net += c.ownerNet;
      ownerNetTotal += c.ownerNet;
    });
    const order = sellersCache.slice().sort((a, b) =>
      (a.role === 'owner' ? 1 : 0) - (b.role === 'owner' ? 1 : 0));
    box.innerHTML = order.map(s => {
      const r = per[s.id] || { count: 0, sold: 0, share: 0, net: 0 };
      const isOwner = s.role === 'owner';
      return '<div class="item">' +
        '<div class="item-head"><span class="item-title">' + esc(s.name) + '</span>' +
        '<span class="badge ' + s.role + '">' + (isOwner ? 'Dueño' : 'Vendedor') + '</span></div>' +
        '<div class="item-rows">' +
        '<span>Ventas: <b>' + r.count + '</b></span>' +
        '<span>Total vendido: <b>' + fmtMoney(r.sold) + '</b></span>' +
        (isOwner
          ? '<span>Neto: <b class="' + (r.net < 0 ? 'neg' : '') + '">' + fmtMoney(r.net) + '</b></span>'
          : '<span>Su parte (50%): <b class="share' + (r.share < 0 ? ' neg' : '') + '">' + fmtMoney(r.share) + '</b></span>') +
        '</div></div>';
    }).join('') || '<div class="empty">Sin vendedores.</div>';
    $('sl-ad').textContent = fmtMoney(adTotal);
    $('sl-net').textContent = fmtMoney(ownerNetTotal);
    $('sl-net').classList.toggle('neg', ownerNetTotal < 0);
  } catch (err) {
    box.innerHTML = '<div class="empty">' + esc(dbError(err)) + '</div>';
  }
}

/* ================= Owner: ad spend ================= */
function initAdForm() {
  if (!$('ad-date').value) $('ad-date').value = todayISO();
  loadAdList();
}

async function saveAdSpend() {
  const errBox = $('ad-error');
  errBox.classList.add('hidden');
  const date = $('ad-date').value;
  const amount = Math.max(0, Number($('ad-amount').value) || 0);
  if (!date) { errBox.textContent = 'Elige la fecha.'; errBox.classList.remove('hidden'); return; }
  const btn = $('ad-save');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    const { error } = await sb.from('ad_spend')
      .upsert({ spend_date: date, amount_dop: amount }, { onConflict: 'spend_date' });
    if (error) throw error;
    toast('Gasto guardado.');
    $('ad-amount').value = '';
    loadAdList();
  } catch (err) {
    errBox.textContent = dbError(err, 'No se pudo guardar.');
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar gasto';
  }
}

async function loadAdList() {
  const list = $('ad-list');
  list.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const { data, error } = await sb.from('ad_spend').select('*')
      .order('spend_date', { ascending: false }).limit(30);
    if (error) throw error;
    if (!data || !data.length) {
      list.innerHTML = '<div class="empty">No hay registros.</div>';
      return;
    }
    list.innerHTML = data.map(r =>
      '<div class="item"><div class="item-head"><span class="item-title">' + fmtDate(r.spend_date) + '</span>' +
      '<strong>' + fmtMoney(r.amount_dop) + '</strong></div>' +
      '<div class="item-actions"><button class="btn btn-ghost btn-xs" data-del="' + r.spend_date + '">Eliminar</button></div></div>'
    ).join('');
    list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteAdSpend(b.dataset.del));
  } catch (err) {
    list.innerHTML = '<div class="empty">' + esc(dbError(err)) + '</div>';
  }
}

async function deleteAdSpend(date) {
  if (!confirm('¿Eliminar el gasto del ' + fmtDate(date) + '?')) return;
  try {
    const { error } = await sb.from('ad_spend').delete().eq('spend_date', date);
    if (error) throw error;
    toast('Eliminado.');
    loadAdList();
  } catch (err) {
    toast(dbError(err, 'No se pudo eliminar.'), true);
  }
}

/* ================= Owner: products ================= */
function loadProducts() {
  renderProductList($('prod-search').value || '');
}

function renderProductList(q) {
  const query = norm(q.trim());
  const matches = query
    ? productsCache.filter(p => norm(p.name).includes(query) || norm(p.reference).includes(query))
    : productsCache;
  $('prod-count').textContent = matches.length + ' productos';
  const slice = matches.slice(0, 120);
  $('prod-list').innerHTML = slice.length ? slice.map(p =>
    '<div class="item"><div class="item-head"><span class="item-title">' + esc(p.name) + '</span></div>' +
    '<div class="item-rows"><span>Ref: <b>' + esc(p.reference || '—') + '</b></span>' +
    '<span>Costo: <b>' + fmtMoney(p.cost_dop) + '</b></span></div></div>'
  ).join('') : '<div class="empty">Sin resultados.</div>';
}

/* ================= Boot ================= */
document.addEventListener('DOMContentLoaded', async () => {
  if (SUPABASE_ANON_KEY === 'sb_publishable_WCyNNOLe4jegZGRbJ6oNPQ_1aBy7mWz') {
    console.warn('Falta configurar la publishable key de Supabase.');
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  $('login-form').addEventListener('submit', handleLogin);
  $('logout-btn').onclick = logout;

  bindSaleForm();
  $('ad-save').onclick = saveAdSpend;

  $('mv-prev').onclick = () => { mySalesMonth.ym = shiftMonth(mySalesMonth.ym, -1); loadMySales(); };
  $('mv-next').onclick = () => { mySalesMonth.ym = shiftMonth(mySalesMonth.ym, 1); loadMySales(); };
  $('rs-prev').onclick = () => { mySummaryMonth.ym = shiftMonth(mySummaryMonth.ym, -1); loadMySummary(); };
  $('rs-next').onclick = () => { mySummaryMonth.ym = shiftMonth(mySummaryMonth.ym, 1); loadMySummary(); };
  $('ow-prev').onclick = () => { ownerMonth.ym = shiftMonth(ownerMonth.ym, -1); loadOwnerSales(); };
  $('ow-next').onclick = () => { ownerMonth.ym = shiftMonth(ownerMonth.ym, 1); loadOwnerSales(); };
  $('sl-prev').onclick = () => { sellersMonth.ym = shiftMonth(sellersMonth.ym, -1); loadSellersSummary(); };
  $('sl-next').onclick = () => { sellersMonth.ym = shiftMonth(sellersMonth.ym, 1); loadSellersSummary(); };
  $('prod-search').addEventListener('input', e => renderProductList(e.target.value));

  try {
    if (await restoreSession()) await enterApp();
  } catch (err) {
    console.error(err);
  }
});
