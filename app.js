/* Finanzas KODEX — web app for sellers (static, Supabase JS v2) */
'use strict';

/* ================= Config ================= */
const SUPABASE_URL = 'https://ltvpjaqafyggenpdbekl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_WCyNNOLe4jegZGRbJ6oNPQ_1aBy7mWz';
const LOGIN_DOMAIN = '@finanzas.kodex';

let sb = null;
let profile = null;            // {id,name,username,role}
let productsCache = [];
let sellersCache = [];
let currentView = 'registrar';
let periodMode = 'month';       // day | month | year | range
let refDateISO = todayISO();
let rangeFromISO = refDateISO.slice(0, 7) + '-01';
let rangeToISO = refDateISO;
let sellerFilterId = '';        // owner only: '' = all sellers
let analysisTab = 'item';       // item | cat
let chartGroup = 'day';        // day | month | year (chart bucketing, independent of periodMode)
let chartMetric = 'sales';      // sales | profit
let editingId = null;
let deleteId = null;
let dashSales = [];             // sales in current dashboard period
let dashAd = {};                // {date: amount}

/* ================= Helpers ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtMoney = n => new Intl.NumberFormat('es-DO', {
  style: 'currency', currency: 'DOP',
  minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(Number(n) || 0);

const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function fmtLong(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return d + ' ' + MESES[m - 1] + ' de ' + y;
}
function badgeParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { d: String(d), m: MESES[m - 1] };
}
function fmtDMY(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(dt.getUTCDate()).padStart(2, '0');
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function periodRange() {
  if (periodMode === 'day') return { from: refDateISO, to: addDays(refDateISO, 1) };
  if (periodMode === 'range') return { from: rangeFromISO, to: addDays(rangeToISO, 1) };
  if (periodMode === 'year') {
    const y = refDateISO.slice(0, 4);
    return { from: y + '-01-01', to: y + '-12-31' };
  }
  const ym = refDateISO.slice(0, 7);
  return { from: ym + '-01', to: shiftMonth(ym, 1) + '-01' };
}
function periodTagText() {
  if (periodMode === 'day') return fmtDMY(refDateISO);
  if (periodMode === 'year') return refDateISO.slice(0, 4);
  if (periodMode === 'range') return fmtDMY(rangeFromISO) + ' – ' + fmtDMY(rangeToISO);
  return refDateISO.slice(5, 7) + '/' + refDateISO.slice(0, 4);
}
const isOwner = () => profile && profile.role === 'owner';

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

/* Profit math:
   margin      = qty*price - qty*cost - shipping
   sellerShare = margin / 2            (ad spend NEVER touches sellers)
   ownerNet (seller sale) = share
   ownerNet (own sale)    = margin - adPortion(date)
   adPortion(date) = ad_spend[date] / nº ventas DEL DUEÑO ese día
   (advertising is absorbed entirely by the owner's own sales) */
const saleMargin = (s, cost) =>
  (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0) -
  (Number(s.quantity) || 0) * (Number(cost) || 0) -
  (Number(s.shipping_cost_dop) || 0);

const productById = id => productsCache.find(p => String(p.id) === String(id));
const sellerById = id => sellersCache.find(s => s.id === id);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

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
  btn.disabled = true; btn.textContent = 'Entrando…';
  try {
    const { data, error } = await sb.auth.signInWithPassword({
      email: username + LOGIN_DOMAIN, password
    });
    if (error) throw error;
    const { data: prof, error: pErr } = await sb.from('sellers')
      .select('id,name,username,role').eq('auth_user_id', data.user.id).single();
    if (pErr || !prof) { await sb.auth.signOut(); throw new Error('profile-missing'); }
    profile = prof;
    await enterApp();
  } catch (err) {
    errBox.textContent = err.message === 'profile-missing'
      ? 'Tu cuenta no tiene un perfil asignado. Habla con Jhowsse.'
      : 'Usuario o contraseña incorrectos.';
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
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
  profile = null; productsCache = []; sellersCache = [];
  dashSales = []; dashAd = {}; editingId = null; sellerFilterId = '';
  $('login-pass').value = '';
  $('view-main').classList.add('hidden');
  $('view-login').classList.remove('hidden');
}

async function changePassword() {
  const p1 = $('new-pass').value, p2 = $('new-pass2').value;
  const errBox = $('pass-error');
  errBox.classList.add('hidden');
  if (!p1 || p1.length < 6) {
    errBox.textContent = 'La contraseña debe tener al menos 6 caracteres.';
    errBox.classList.remove('hidden'); return;
  }
  if (p1 !== p2) {
    errBox.textContent = 'Las contraseñas no coinciden.';
    errBox.classList.remove('hidden'); return;
  }
  const btn = $('pass-save');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) throw error;
    closeModal('modal-pass-back');
    $('new-pass').value = ''; $('new-pass2').value = '';
    toast('Contraseña actualizada.');
  } catch (err) {
    errBox.textContent = dbError(err, 'No se pudo cambiar la contraseña.');
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

/* ================= Navigation ================= */
function showView(v) {
  currentView = v;
  $('view-registrar').classList.toggle('hidden', v !== 'registrar');
  $('view-dashboard').classList.toggle('hidden', v !== 'dashboard');
  $('nav-registrar').classList.toggle('active', v === 'registrar');
  $('nav-dashboard').classList.toggle('active', v === 'dashboard');
  if (v === 'registrar') loadRecent();
  if (v === 'dashboard') loadDashboard();
}

async function enterApp() {
  $('topbar-user').textContent = profile.name + (isOwner() ? ' · Dueño' : ' · Vendedor');
  $('view-login').classList.add('hidden');
  $('view-main').classList.remove('hidden');
  // owner-only controls
  document.querySelectorAll('#btn-refresh-sources, #btn-refresh-all').forEach(b =>
    b.classList.toggle('hidden', !isOwner()));
  $('card-ad-days').classList.toggle('hidden', !isOwner());
  $('card-sources').classList.toggle('hidden', !isOwner());
  $('seller-filter-wrap').classList.toggle('hidden', !isOwner());
  try {
    const { data, error } = await sb.from('products')
      .select('id,name,reference,category,subcategory,cost_dop').order('name');
    if (error) throw error;
    productsCache = data || [];
    if (isOwner()) {
      const { data: ss, error: sErr } = await sb.from('sellers').select('id,name,username,role').order('name');
      if (sErr) throw sErr;
      sellersCache = ss || [];
      buildSellerFilter();
    }
    buildProductSelect();
  } catch (err) {
    toast(dbError(err, 'No se pudo cargar el catálogo.'), true);
  }
  resetSaleForm();
  showView('registrar');
}

/* ================= Sale form ================= */
function buildProductSelect() {
  document.querySelectorAll('.item-product').forEach(sel => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Selecciona un producto</option>' +
      productsCache.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
    if (cur) sel.value = cur;
  });
}

function itemBlocks() { return [...document.querySelectorAll('#sale-items .sale-item')]; }

function blockParts(block) {
  return {
    search: block.querySelector('.item-search'),
    results: block.querySelector('.ac-results'),
    sel: block.querySelector('.item-product'),
    qty: block.querySelector('.item-qty'),
    cost: block.querySelector('.item-cost'),
    price: block.querySelector('.item-price'),
  };
}

function bindItemBlock(block) {
  const { search, results, sel, qty, cost, price } = blockParts(block);
  search.addEventListener('input', () => {
    const q = norm(search.value.trim());
    if (q.length < 2) { results.classList.add('hidden'); return; }
    const matches = productsCache.filter(p =>
      norm(p.name).includes(q) || norm(p.reference).includes(q)).slice(0, 8);
    if (!matches.length) { results.classList.add('hidden'); return; }
    results.innerHTML = matches.map(p =>
      '<div class="ac-item" data-id="' + p.id + '"><div class="n">' + esc(p.name) +
      '</div><div class="m">' + esc(p.reference || '') + ' · ' + fmtMoney(p.cost_dop) + '</div></div>'
    ).join('');
    results.classList.remove('hidden');
    results.querySelectorAll('.ac-item').forEach(o =>
      o.onclick = () => { selectBlockProduct(block, o.dataset.id); results.classList.add('hidden'); search.value = ''; });
  });
  document.addEventListener('click', e => {
    if (!results.contains(e.target) && e.target !== search) results.classList.add('hidden');
  });
  sel.addEventListener('change', () => selectBlockProduct(block, sel.value || null));
  [qty, cost, price].forEach(el => el.addEventListener('input', updateSummary));
  const rm = block.querySelector('.item-remove');
  if (rm) rm.onclick = () => { block.remove(); renumberItems(); updateSummary(); };
}

function selectBlockProduct(block, id) {
  const p = id ? productById(id) : null;
  const { sel, cost } = blockParts(block);
  sel.value = p ? String(p.id) : '';
  cost.value = p ? (p.cost_dop === 0 ? '' : Number(p.cost_dop)) : '';
  cost.placeholder = p ? (p.cost_dop === 0 ? 'Pendiente — escríbelo' : '') : 'Pendiente';
  updateSummary();
}

function renumberItems() {
  const blocks = itemBlocks();
  blocks.forEach((b, i) => {
    b.querySelector('.item-title').textContent = 'Producto ' + (i + 1);
    const rm = b.querySelector('.item-remove');
    if (rm) rm.classList.toggle('hidden', blocks.length <= 1 || !!editingId);
  });
  $('sale-add-item').classList.toggle('hidden', !!editingId);
}

function addItemBlock() {
  const block = document.createElement('div');
  block.className = 'sale-item';
  block.innerHTML =
    '<div class="item-head"><span class="item-title"></span>' +
    '<button type="button" class="item-remove">Quitar</button></div>' +
    '<label class="field"><span>Buscar producto</span><div class="ac-wrap">' +
    '<input type="text" class="item-search" placeholder="Modelo, referencia o marca" autocomplete="off">' +
    '<div class="ac-results hidden"></div></div></label>' +
    '<label class="field"><span>Producto</span><select class="item-product">' +
    '<option value="">Selecciona un producto</option></select></label>' +
    '<div class="row3">' +
    '<label class="field"><span>Cantidad</span><input type="number" class="item-qty" value="1" min="1" step="1" inputmode="numeric"></label>' +
    '<label class="field"><span>Costo Omega (RD$)</span><input type="number" class="item-cost" placeholder="Pendiente" min="0" step="0.01" inputmode="decimal"></label>' +
    '<label class="field"><span>Precio de venta (RD$)</span><input type="number" class="item-price" placeholder="0.00" min="0" step="1" inputmode="decimal"></label>' +
    '</div>';
  $('sale-items').appendChild(block);
  buildProductSelect();
  bindItemBlock(block);
  renumberItems();
  blockParts(block).search.focus();
}

function bindSaleForm() {
  bindItemBlock(itemBlocks()[0]);
  $('sale-ship').addEventListener('input', updateSummary);
  $('sale-add-item').onclick = addItemBlock;
  $('sale-save').onclick = saveSale;
  $('sale-cancel').onclick = resetSaleForm;
}

function readBlock(block) {
  const { sel, qty, cost, price } = blockParts(block);
  return {
    product: sel.value ? productById(sel.value) : null,
    qty: Math.max(1, parseInt(qty.value, 10) || 1),
    cost: Math.max(0, Number(cost.value) || 0),
    price: Math.max(0, Number(price.value) || 0),
  };
}

function readSaleCommon() {
  return {
    ship: Math.max(0, Number($('sale-ship').value) || 0),
    date: $('sale-date').value || todayISO(),
    desc: $('sale-desc').value.trim().slice(0, 300),
  };
}

function updateSummary() {
  let venta = 0, gross = 0;
  itemBlocks().forEach(b => {
    const it = readBlock(b);
    venta += it.qty * it.price;
    gross += it.qty * it.price - it.qty * it.cost;
  });
  const ship = Math.max(0, Number($('sale-ship').value) || 0);
  const margin = gross - ship;
  const pct = venta > 0 ? (margin / venta * 100) : 0;
  $('ss-venta').textContent = fmtMoney(venta);
  if (isOwner()) {
    $('ss-mid-label').textContent = 'Ganancia antes de anuncios';
    $('ss-mid').textContent = fmtMoney(margin);
  } else {
    $('ss-mid-label').textContent = 'Tu parte (50%)';
    $('ss-mid').textContent = fmtMoney(margin / 2);
  }
  $('ss-margen').textContent = pct.toFixed(1) + '%';
}

function resetSaleForm() {
  editingId = null;
  setSaleDate(todayISO());
  const blocks = itemBlocks();
  blocks.slice(1).forEach(b => b.remove());
  const first = blockParts(blocks[0]);
  first.qty.value = '1';
  first.search.value = '';
  first.sel.value = '';
  first.cost.value = ''; first.cost.placeholder = 'Pendiente';
  first.price.value = '';
  $('sale-ship').value = '0';
  $('sale-desc').value = '';
  $('sale-error').classList.add('hidden');
  $('sale-save').textContent = 'Registrar venta';
  $('sale-cancel').classList.add('hidden');
  renumberItems();
  updateSummary();
}

async function persistManualCost(it) {
  if (it.product && it.product.cost_dop === 0 && it.cost > 0) {
    try {
      await sb.from('products').update({ cost_dop: it.cost }).eq('id', it.product.id);
      it.product.cost_dop = it.cost;
    } catch (_) { /* best effort: RLS may not allow */ }
  }
}

async function saveSale() {
  const errBox = $('sale-error');
  errBox.classList.add('hidden');
  const common = readSaleCommon();
  const btn = $('sale-save');

  if (editingId) {
    const it = readBlock(itemBlocks()[0]);
    if (!it.product) { errBox.textContent = 'Busca y elige un producto primero.'; errBox.classList.remove('hidden'); return; }
    if (it.price <= 0) { errBox.textContent = 'Escribe el precio de venta.'; errBox.classList.remove('hidden'); return; }
    const orig = findSaleInCache(editingId);
    btn.disabled = true; btn.textContent = 'Guardando…';
    const row = {
      seller_id: orig ? orig.seller_id : profile.id,
      product_id: it.product.id,
      quantity: it.qty,
      unit_sale_price_dop: it.price,
      shipping_cost_dop: common.ship,
      sale_date: common.date,
      description: common.desc,
    };
    try {
      const { error } = await sb.from('sales').update(row).eq('id', editingId);
      if (error) throw error;
      await persistManualCost(it);
      toast('Venta actualizada.');
      resetSaleForm();
      loadRecent();
    } catch (err) {
      errBox.textContent = dbError(err, 'No se pudo guardar la venta.');
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = editingId ? 'Guardar cambios' : 'Registrar venta';
    }
    return;
  }

  const items = itemBlocks().map(readBlock);
  for (let i = 0; i < items.length; i++) {
    if (!items[i].product) { errBox.textContent = 'Elige el producto ' + (i + 1) + '.'; errBox.classList.remove('hidden'); return; }
    if (items[i].price <= 0) { errBox.textContent = 'Escribe el precio de venta del producto ' + (i + 1) + '.'; errBox.classList.remove('hidden'); return; }
  }
  btn.disabled = true; btn.textContent = 'Guardando…';
  const batch = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  const rows = items.map((it, i) => ({
    seller_id: profile.id,
    product_id: it.product.id,
    quantity: it.qty,
    unit_sale_price_dop: it.price,
    shipping_cost_dop: i === 0 ? common.ship : 0,
    sale_date: common.date,
    description: common.desc,
    batch_id: batch,
  }));
  try {
    const { error } = await sb.from('sales').insert(rows);
    if (error) throw error;
    for (const it of items) await persistManualCost(it);
    toast(items.length > 1 ? 'Venta registrada (' + items.length + ' productos).' : 'Venta registrada.');
    resetSaleForm();
    loadRecent();
  } catch (err) {
    errBox.textContent = dbError(err, 'No se pudo guardar la venta.');
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar venta';
  }
}

function editSale(id) {
  const s = allSalesCache.find(x => x.id === id) || dashSales.find(x => x.id === id);
  if (!s) return;
  resetSaleForm();
  editingId = id;
  showView('registrar');
  setSaleDate(s.sale_date);
  const first = blockParts(itemBlocks()[0]);
  const p = productById(s.product_id);
  first.sel.value = p ? String(p.id) : '';
  const cost = p ? Number(p.cost_dop) : 0;
  first.qty.value = s.quantity;
  first.cost.value = cost === 0 ? '' : cost;
  first.price.value = s.unit_sale_price_dop;
  $('sale-ship').value = s.shipping_cost_dop;
  $('sale-desc').value = s.description || '';
  $('sale-save').textContent = 'Guardar cambios';
  $('sale-cancel').classList.remove('hidden');
  renumberItems();
  updateSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function confirmDelete() {
  if (!deleteId) return;
  try {
    const { error } = await sb.from('sales').delete().eq('id', deleteId);
    if (error) throw error;
    toast('Venta eliminada.');
    closeModal('modal-del-back');
    deleteId = null;
    loadRecent();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    toast(dbError(err, 'No se pudo eliminar.'), true);
  }
}

/* ================= Sale cards ================= */
let allSalesCache = [];   // recent sales (registrar view)

function batchCountsOf(rows) {
  const m = {};
  (rows || []).forEach(x => { if (x.batch_id) m[x.batch_id] = (m[x.batch_id] || 0) + 1; });
  return m;
}

function saleCardHTML(s, opts) {
  const p = productById(s.product_id);
  const bp = badgeParts(s.sale_date);
  const cost = p ? Number(p.cost_dop) : 0;
  const venta = (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0);
  const margin = saleMargin(s, cost);
  const seller = sellerById(s.seller_id);
  const qtyTxt = s.quantity + ' × ' + fmtMoney(s.unit_sale_price_dop);

  let nums;
  if (isOwner()) {
    const isOwn = s.seller_id === profile.id;
    if (isOwn) {
      const adP = opts.adPortion || 0;
      const net = margin - adP;
      nums =
        '<div><div class="sn-label">Venta</div><div class="sn-value">' + fmtMoney(venta) + '</div>' +
        '<div class="sn-label" style="margin-top:8px">Publicidad asignada</div><div class="sn-value">−' + fmtMoney(adP) + '</div></div>' +
        '<div style="text-align:right"><div class="sn-label">Ganancia</div><div class="sn-value">' + fmtMoney(margin) + '</div>' +
        '<div class="sn-label" style="margin-top:8px">Ganancia neta</div><div class="sn-value green">' + fmtMoney(net) + '</div></div>';
    } else {
      // seller's sale: ad spend never applies — owner's half, no ad rows
      nums =
        '<div><div class="sn-label">Venta</div><div class="sn-value">' + fmtMoney(venta) + '</div></div>' +
        '<div style="text-align:right"><div class="sn-label">Ganancia neta</div><div class="sn-value green">' + fmtMoney(margin / 2) + '</div></div>';
    }
  } else {
    nums =
      '<div><div class="sn-label">Venta</div><div class="sn-value">' + fmtMoney(venta) + '</div></div>' +
      '<div style="text-align:right"><div class="sn-label">Tu parte (50%)</div><div class="sn-value green">' + fmtMoney(margin / 2) + '</div></div>';
  }

  return '<div class="sale-card' + ((!isOwner() && s.paid) ? ' paid-card' : '') + '">' +
    '<div class="sale-top">' +
      '<div class="date-badge" title="' + fmtDMY(s.sale_date) + '"><div class="d">' + bp.d + '</div><div class="m">' + bp.m + '</div></div>' +
      '<div class="sale-info">' +
        '<div class="sale-name">' + esc(p ? p.name : 'Producto') + '</div>' +
        '<div class="sale-sub">' + esc(qtyTxt) + '</div>' +
        (s.description ? '<div class="sale-desc">' + esc(s.description) + '</div>' : '') +
        (isOwner() && seller ? '<span class="seller-badge">' + esc(seller.name) + '</span>' : '') +
        ((opts.batchCount || 1) > 1 ? '<span class="batch-badge">Venta múltiple · ' + opts.batchCount + ' productos</span>' : '') +
        ((!isOwner() && s.paid) ? '<span class="paid-badge">Pagado ✓</span>' : '') +
        '<div class="sale-links">' +
          '<button class="link-dim" data-edit="' + s.id + '">Editar</button>' +
          '<button class="link-dim" data-del="' + s.id + '">Eliminar</button>' +
          ((isOwner() && s.seller_id !== profile.id)
            ? '<button class="paid-btn ' + (s.paid ? 'paid-on' : 'paid-off') + '" data-paid="' + s.id + '" data-paid-state="' + (s.paid ? '1' : '0') + '">' + (s.paid ? 'Pagado ✓' : 'Marcar pagado') + '</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="sale-nums">' + nums + '</div>' +
  '</div>';
}

function findSaleInCache(id) {
  return allSalesCache.find(x => Number(x.id) === id) || dashSales.find(x => Number(x.id) === id);
}

function paintPaidButton(btn, paid) {
  btn.className = 'paid-btn ' + (paid ? 'paid-on' : 'paid-off');
  btn.textContent = paid ? 'Pagado ✓' : 'Marcar pagado';
  btn.dataset.paidState = paid ? '1' : '0';
}

async function togglePaid(btn, saleId, currentlyPaid) {
  const newPaid = !currentlyPaid;
  const cached = findSaleInCache(saleId);
  // a multi-product registration is paid (or un-paid) as a whole
  let ids = [saleId];
  if (cached && cached.batch_id) {
    const same = [...allSalesCache, ...dashSales].filter(x => x.batch_id === cached.batch_id);
    ids = [...new Set(same.map(x => Number(x.id)))];
    if (!ids.includes(saleId)) ids.push(saleId);
  }
  const paintAll = val => document.querySelectorAll('[data-paid]').forEach(b => {
    if (ids.includes(Number(b.dataset.paid))) paintPaidButton(b, val);
  });
  const setCaches = val => [...allSalesCache, ...dashSales].forEach(x => {
    if (ids.includes(Number(x.id))) x.paid = val;
  });
  paintAll(newPaid);                       // instant UI
  setCaches(newPaid);
  btn.disabled = true;
  try {
    const { error } = await sb.from('sales').update({ paid: newPaid }).in('id', ids);
    if (error) throw error;
    toast(newPaid ? 'Venta marcada como pagada.' : 'Venta marcada como pendiente de pago.');
  } catch (err) {
    setCaches(currentlyPaid);
    paintAll(currentlyPaid);
    toast(dbError(err, 'No se pudo actualizar el estado de pago.'), true);
  } finally {
    btn.disabled = false;
  }
}

function bindSaleCardButtons(container) {
  container.querySelectorAll('[data-edit]').forEach(b =>
    b.onclick = () => editSale(Number(b.dataset.edit)));
  container.querySelectorAll('[data-del]').forEach(b =>
    b.onclick = () => { deleteId = Number(b.dataset.del); openModal('modal-del-back'); });
  container.querySelectorAll('[data-paid]').forEach(b =>
    b.onclick = () => togglePaid(b, Number(b.dataset.paid), b.dataset.paidState === '1'));
}

async function loadRecent() {
  const box = $('recent-sales');
  box.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    let q = sb.from('sales').select('*').order('sale_date', { ascending: false })
      .order('created_at', { ascending: false }).limit(10);
    if (!isOwner()) q = q.eq('seller_id', profile.id);
    const { data, error } = await q;
    if (error) throw error;
    allSalesCache = data || [];
    // ad portions for owner
    let adMap = {};
    if (isOwner() && allSalesCache.length) {
      const dates = [...new Set(allSalesCache.map(s => s.sale_date))];
      const { data: ads } = await sb.from('ad_spend').select('spend_date,amount_dop')
        .in('spend_date', dates);
      const { data: allDay } = await sb.from('sales').select('sale_date,seller_id').in('sale_date', dates);
      (ads || []).forEach(a => adMap[a.spend_date] = Number(a.amount_dop));
      var dayCounts = {};
      // ad spend is split only among the OWNER's sales of the day
      (allDay || []).forEach(s => { if (s.seller_id === profile.id) dayCounts[s.sale_date] = (dayCounts[s.sale_date] || 0) + 1; });
    }
    if (!allSalesCache.length) { box.innerHTML = '<div class="empty">Sin ventas todavía.</div>'; return; }
    const bc = batchCountsOf(allSalesCache);
    box.innerHTML = allSalesCache.map(s => {
      let adP = 0;
      if (isOwner()) {
        const amt = Number(adMap[s.sale_date]) || 0;
        const n = dayCounts[s.sale_date] || 1;
        adP = amt / n;
      }
      return saleCardHTML(s, { adPortion: adP, batchCount: s.batch_id ? (bc[s.batch_id] || 1) : 1 });
    }).join('');
    bindSaleCardButtons(box);
  } catch (err) {
    box.innerHTML = '<div class="empty">No se pudieron cargar las ventas.</div>';
  }
}

/* ================= Dashboard ================= */
function buildSellerFilter() {
  const sel = $('seller-filter');
  sel.innerHTML = '<option value="">Todos</option>' +
    sellersCache.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
  sel.value = sellerFilterId;
}

function syncFilterUI() {
  const isRange = periodMode === 'range';
  $('ref-field').classList.toggle('hidden', isRange);
  $('range-fields').classList.toggle('hidden', !isRange);
  $('ref-date-btn-label').textContent = fmtDMY(refDateISO);
  if (isRange) $('range-btn-label').textContent = fmtDMY(rangeFromISO) + ' – ' + fmtDMY(rangeToISO);
}

/* ============ Range picker (v7) ============ */
const MESES_LONG = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
  'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
let pkViewY = 0, pkViewM = 0;
let pkFrom = null, pkTo = null, pkLastPreset = null;
let pkMode = 'range';            // 'range' | 'single'
let pkSingleTarget = null;       // 'sale' | 'ref' | 'ad'
let pkSingleVal = null;

function pkOpen() {
  pkMode = 'range';
  pkFrom = rangeFromISO; pkTo = rangeToISO; pkLastPreset = null;
  const [y, m] = pkTo.split('-').map(Number);
  pkViewY = y; pkViewM = m - 1;
  pkRender();
  $('picker-back').classList.remove('hidden');
}
function pkOpenSingle(target) {
  pkMode = 'single'; pkSingleTarget = target; pkLastPreset = null;
  const hid = target === 'sale' ? 'sale-date' : target === 'ref' ? 'ref-date' : 'ad-date';
  pkSingleVal = $(hid).value || todayISO();
  const [y, m] = pkSingleVal.split('-').map(Number);
  pkViewY = y; pkViewM = m - 1;
  pkRender();
  $('picker-back').classList.remove('hidden');
}
function pkClose() { $('picker-back').classList.add('hidden'); }
function pkShiftView(d) {
  const dt = new Date(pkViewY, pkViewM + d, 1);
  pkViewY = dt.getFullYear(); pkViewM = dt.getMonth();
  pkRender();
}
function pkRender() {
  $('pk-title').textContent = MESES_LONG[pkViewM] + ' ' + pkViewY;
  const single = pkMode === 'single';
  // presets: single mode shows only Hoy/Ayer
  document.querySelectorAll('#pk-presets button').forEach(x => {
    const show = single ? (x.dataset.pr === 'today' || x.dataset.pr === 'yesterday') : true;
    x.style.display = show ? '' : 'none';
    x.classList.toggle('active', x.dataset.pr === pkLastPreset);
  });
  // footer labels
  $('pk-from-label').textContent = single ? 'Fecha' : 'Fecha de inicio';
  $('pk-to-wrap').classList.toggle('hidden', single);
  const grid = $('pk-grid');
  grid.innerHTML = '';
  const first = new Date(pkViewY, pkViewM, 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  for (let i = 0; i < 42; i++) {
    const d = new Date(pkViewY, pkViewM, 1 - offset + i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pk-day';
    b.textContent = d.getDate();
    if (d.getMonth() !== pkViewM) b.classList.add('dim');
    if (single) {
      if (iso === pkSingleVal) b.classList.add('single');
    } else if (pkFrom && pkTo) {
      if (iso === pkFrom && iso === pkTo) b.classList.add('single');
      else {
        if (iso === pkFrom) b.classList.add('range-start');
        if (iso === pkTo) b.classList.add('range-end');
        if (iso > pkFrom && iso < pkTo) b.classList.add('in-range');
      }
    } else if (pkFrom && iso === pkFrom) b.classList.add('single');
    b.addEventListener('click', () => single ? pkPickSingle(iso) : pkPick(iso));
    grid.appendChild(b);
  }
  $('pk-from').textContent = fmtDMY(single ? pkSingleVal : pkFrom);
  $('pk-to').textContent = fmtDMY(pkTo);
}
function pkPick(iso) {
  pkLastPreset = null;
  if (!pkFrom || (pkFrom && pkTo)) { pkFrom = iso; pkTo = null; }
  else if (iso >= pkFrom) { pkTo = iso; }
  else { pkFrom = iso; }
  pkRender();
}
function pkPickSingle(iso) {
  pkLastPreset = null;
  pkSingleVal = iso;
  pkRender();
}
function pkSetSingle(iso) {
  pkSingleVal = iso;
  const [y, m] = iso.split('-').map(Number);
  pkViewY = y; pkViewM = m - 1;
  pkRender();
}
function pkSetRange(from, to) {
  pkFrom = from; pkTo = to;
  const [y, m] = to.split('-').map(Number);
  pkViewY = y; pkViewM = m - 1;
  pkRender();
}
function pkPresetDates(which) {
  const t = todayISO();
  const dow = (new Date(t + 'T12:00:00Z').getUTCDay() + 6) % 7; // Monday-first
  const monday = addDays(t, -dow);
  const thisMonthStart = t.slice(0, 7) + '-01';
  switch (which) {
    case 'today': return [t, t];
    case 'yesterday': { const y = addDays(t, -1); return [y, y]; }
    case 'thisWeek': return [monday, addDays(monday, 6)];
    case 'lastWeek': { const s = addDays(monday, -7); return [s, addDays(s, 6)]; }
    case 'thisMonth': return [thisMonthStart, t];
    case 'lastMonth': {
      const prevStart = shiftMonth(t.slice(0, 7), -1) + '-01';
      return [prevStart, addDays(thisMonthStart, -1)];
    }
    case 'last7': return [addDays(t, -6), t];
    case 'last30': return [addDays(t, -29), t];
    default: return [t, t];
  }
}
function pkApply() {
  if (pkMode === 'single') {
    if (!pkSingleVal) { toast('Selecciona una fecha.', true); return; }
    const v = pkSingleVal;
    pkClose();
    if (pkSingleTarget === 'sale') setSaleDate(v);
    else if (pkSingleTarget === 'ref') {
      $('ref-date').value = v; refDateISO = v;
      syncFilterUI(); loadDashboard();
    } else {
      $('ad-date').value = v; $('ad-date-label').textContent = fmtDMY(v);
    }
    return;
  }
  if (!pkFrom) { toast('Selecciona la fecha de inicio.', true); return; }
  rangeFromISO = pkFrom;
  rangeToISO = pkTo || pkFrom;
  pkClose();
  syncFilterUI();
  loadDashboard();
}

/* single-date field helpers */
function setSaleDate(iso) {
  $('sale-date').value = iso;
  $('sale-date-label').textContent = fmtDMY(iso);
  $('reg-date-label').textContent = fmtLong(iso);
}

function dashQuery() {
  const { from, to } = periodRange();
  let q = sb.from('sales').select('*')
    .gte('sale_date', from).order('sale_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (periodMode !== 'year') q = q.lt('sale_date', to);
  else q = q.lte('sale_date', to);
  if (!isOwner()) q = q.eq('seller_id', profile.id);
  else if (sellerFilterId) q = q.eq('seller_id', sellerFilterId);
  return q;
}

async function loadDashboard() {
  const { from, to } = periodRange();
  $('period-tag').textContent = periodTagText();
  $('analysis-tag').textContent = $('period-tag').textContent;
  $('chart-eyebrow').textContent = chartGroup === 'year' ? 'Por año' :
    chartGroup === 'month' ? 'Por mes' : 'Por día';
  $('analysis-eyebrow').textContent = 'Respeta el filtro de ' +
    (periodMode === 'day' ? 'día' : periodMode === 'year' ? 'año' :
     periodMode === 'range' ? 'rango' : 'mes');
  try {
    const { data: sales, error } = await dashQuery();
    if (error) throw error;
    dashSales = sales || [];
    dashAd = {};
    if (isOwner()) {
      let aq = sb.from('ad_spend').select('spend_date,amount_dop').gte('spend_date', from);
      aq = periodMode === 'year' ? aq.lte('spend_date', to) : aq.lt('spend_date', to);
      const { data: ads } = await aq;
      (ads || []).forEach(a => dashAd[a.spend_date] = Number(a.amount_dop));
    }
    renderStats();
    renderChart();
    renderTopProducts();
    renderAnalysis();
    if (isOwner()) { renderAdDays(); }
    renderHistory();
  } catch (err) {
    toast(dbError(err, 'No se pudo cargar el panel.'), true);
  }
}

function adPortionMap() {
  const counts = {};
  // ad spend is divided only among the OWNER's sales of each day
  dashSales.forEach(s => { if (s.seller_id === profile.id) counts[s.sale_date] = (counts[s.sale_date] || 0) + 1; });
  const map = {};
  Object.keys(dashAd).forEach(d => {
    const n = counts[d] || 0;
    map[d] = n > 0 ? dashAd[d] / n : 0;
  });
  return map;
}

function renderStats() {
  const row = $('stats-row');
  const n = dashSales.length;
  const ventas = dashSales.reduce((a, s) => a + (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0), 0);
  const units = dashSales.reduce((a, s) => a + (Number(s.quantity) || 0), 0);
  if (isOwner()) {
    const costo = dashSales.reduce((a, s) => {
      const p = productById(s.product_id);
      return a + (Number(s.quantity) || 0) * (p ? Number(p.cost_dop) : 0);
    }, 0);
    const envios = dashSales.reduce((a, s) => a + (Number(s.shipping_cost_dop) || 0), 0);
    const adMap = adPortionMap();
    const adTotal = Object.keys(dashAd).reduce((a, d) => a + dashAd[d], 0);
    const adAssigned = dashSales.reduce((a, s) => a + (s.seller_id === profile.id ? (adMap[s.sale_date] || 0) : 0), 0);
    const adUnassigned = adTotal - adAssigned;
    let net = 0;
    dashSales.forEach(s => {
      const p = productById(s.product_id);
      const m = saleMargin(s, p ? Number(p.cost_dop) : 0);
      // ad spend is deducted ONLY from the owner's own sales
      net += s.seller_id === profile.id ? m - (adMap[s.sale_date] || 0) : m / 2;
    });
    const marginPct = ventas > 0 ? (net / ventas * 100) : 0;
    row.innerHTML =
      statHTML('Ventas', fmtMoney(ventas), n + ' ventas · ' + units + ' unidades') +
      statHTML('Costo productos', fmtMoney(costo), '') +
      statHTML('Envíos', fmtMoney(envios), '') +
      statHTML('Publicidad', fmtMoney(adTotal), fmtMoney(adUnassigned) + ' en días sin ventas') +
      statHTML('Ganancia neta', (net < 0 ? '−' : '') + fmtMoney(Math.abs(net)),
        'Margen ' + marginPct.toFixed(1) + '%', net < 0 ? 'red' : '');
  } else {
    let share = 0;
    dashSales.forEach(s => {
      const p = productById(s.product_id);
      share += saleMargin(s, p ? Number(p.cost_dop) : 0) / 2;
    });
    row.innerHTML =
      statHTML('Ventas', fmtMoney(ventas), n + ' ventas · ' + units + ' unidades') +
      statHTML('Mi parte (50%)', fmtMoney(share), '', 'green') +
      statHTML('N.º ventas', String(n), '');
  }
}
function statHTML(label, value, sub, cls) {
  return '<div class="stat"><div class="s-label">' + label + '</div>' +
    '<div class="s-value' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
    (sub ? '<div class="s-sub">' + sub + '</div>' : '') + '</div>';
}

/* Net profit of one sale, same logic as the dashboard cards:
   owner's own sale -> margin - adPortion; seller's sale -> margin/2 (owner view);
   seller view -> margin/2 */
function saleNetOf(s, adMap) {
  const p = productById(s.product_id);
  const m = saleMargin(s, p ? Number(p.cost_dop) : 0);
  if (isOwner()) return s.seller_id === profile.id ? m - (adMap[s.sale_date] || 0) : m / 2;
  return m / 2;
}

function renderChart() {
  const box = $('chart');
  $('chart-metric-tag').classList.toggle('hidden', chartMetric !== 'profit');
  const W = 640, H = 300, PL = 44, PB = 30, PT = 8;
  const adMap = isOwner() ? adPortionMap() : {};
  const valOf = chartMetric === 'profit'
    ? (s => saleNetOf(s, adMap))
    : (s => (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0));
  const keyOf = s => chartGroup === 'year' ? s.sale_date.slice(0, 4)
    : chartGroup === 'month' ? s.sale_date.slice(0, 7) : s.sale_date;
  const multiYear = new Set(dashSales.map(s => s.sale_date.slice(0, 4))).size > 1;
  const labelOf = k => {
    if (chartGroup === 'year') return k;
    if (chartGroup === 'month') {
      const mm = MESES[Number(k.slice(5, 7)) - 1];
      return multiYear ? mm + " '" + k.slice(2, 4) : mm;
    }
    return k.slice(8, 10);
  };
  const agg = {};
  dashSales.forEach(s => { const k = keyOf(s); agg[k] = (agg[k] || 0) + valOf(s); });
  const shown = Object.keys(agg).sort()
    .map(k => ({ label: labelOf(k), total: agg[k] }))
    .filter(b => b.total !== 0);
  if (!shown.length) { box.innerHTML = '<div class="empty">Sin ventas en el período.</div>'; return; }
  const vals = shown.map(b => b.total);
  const hi = Math.max(1, ...vals), lo = Math.min(0, ...vals);
  const step = niceStep(hi - lo);
  const yMax = Math.ceil(hi / step) * step;
  const yMin = Math.floor(lo / step) * step;
  const span = (yMax - yMin) || 1;
  const iw = W - PL - 8, ih = H - PT - PB;
  const yOf = v => PT + ih - ((v - yMin) / span) * ih;
  const bw = Math.min(120, (iw / Math.max(1, shown.length)) * 0.55);
  const barFill = chartMetric === 'profit' ? '#4ade80' : '#22c55e';
  const tipLabel = chartMetric === 'profit' ? 'Ganancia' : 'Ventas';
  const axFmt = v => Math.abs(v) >= 1000 ? (v / 1000) + ' K' : String(v);
  let svg = '<svg class="bar-chart" viewBox="0 0 ' + W + ' ' + H + '">';
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const y = yOf(v);
    svg += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + W + '" y2="' + y.toFixed(1) +
      '" stroke="#1a222c" stroke-width="1"/>' +
      '<text x="' + (PL - 8) + '" y="' + (y + 4).toFixed(1) + '" fill="#5d6672" font-size="11" text-anchor="end">' +
      axFmt(v) + '</text>';
  }
  shown.forEach((b, i) => {
    const y0 = yOf(0), y1 = yOf(b.total);
    const y = Math.min(y0, y1), h = Math.abs(y1 - y0);
    const x = PL + (iw / shown.length) * i + ((iw / shown.length) - bw) / 2;
    const fill = b.total < 0 ? '#ef4444' : barFill;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
      '" height="' + Math.max(0, h).toFixed(1) + '" rx="5" fill="' + fill + '">' +
      '<title>' + tipLabel + ': ' + fmtMoney(b.total) + '</title></rect>';
    if (shown.length <= 31) {
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" fill="#5d6672" font-size="11" text-anchor="middle">' + esc(b.label) + '</text>';
    }
  });
  svg += '</svg>';
  box.innerHTML = svg;
}
function niceStep(max) {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
}

function renderTopProducts() {
  const box = $('top-products');
  const agg = {};
  dashSales.forEach(s => {
    const p = productById(s.product_id);
    const key = s.product_id;
    if (!agg[key]) agg[key] = { name: p ? p.name : 'Producto', units: 0, total: 0 };
    agg[key].units += Number(s.quantity) || 0;
    agg[key].total += (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0);
  });
  const rows = Object.values(agg).sort((a, b) => b.units - a.units).slice(0, 8);
  if (!rows.length) { box.innerHTML = '<div class="empty">Sin ventas en el período.</div>'; return; }
  box.innerHTML = rows.map((r, i) =>
    '<div class="rank-row"><span class="rk">' + String(i + 1).padStart(2, '0') + '</span>' +
    '<div class="rn"><div class="t">' + esc(r.name) + '</div>' +
    '<div class="s">' + fmtMoney(r.total) + ' en ventas</div></div>' +
    '<span class="rc">' + r.units + '</span></div>'
  ).join('');
}

function renderAnalysis() {
  const tb = $('analysis-table').querySelector('tbody');
  $('analysis-net-head').textContent = isOwner() ? 'Ganancia neta' : 'Mi parte';
  const adMap = isOwner() ? adPortionMap() : {};
  const agg = {};
  dashSales.forEach(s => {
    const p = productById(s.product_id);
    const key = analysisTab === 'item' ? s.product_id : (p ? (p.category || 'Sin categoría') : 'Sin categoría');
    if (!agg[key]) agg[key] = {
      name: analysisTab === 'item' ? (p ? p.name : 'Producto') : key,
      sub: analysisTab === 'item' ? (p ? (p.category || '') : '') : '',
      units: 0, ingresos: 0, net: 0
    };
    const qty = Number(s.quantity) || 0;
    const ing = qty * (Number(s.unit_sale_price_dop) || 0);
    const m = saleMargin(s, p ? Number(p.cost_dop) : 0);
    let net;
    if (isOwner()) {
      // ad spend is deducted ONLY from the owner's own sales
      net = s.seller_id === profile.id ? m - (adMap[s.sale_date] || 0) : m / 2;
    } else {
      net = m / 2;
    }
    agg[key].units += qty; agg[key].ingresos += ing; agg[key].net += net;
  });
  const rows = Object.values(agg).sort((a, b) => b.ingresos - a.ingresos);
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">Sin ventas en el período.</td></tr>'; return; }
  tb.innerHTML = rows.map(r =>
    '<tr><td><div style="font-weight:700">' + esc(r.name) + '</div>' +
    (r.sub ? '<div class="sub">' + esc(r.sub) + '</div>' : '') + '</td>' +
    '<td class="num">' + r.units + '</td>' +
    '<td class="num">' + fmtMoney(r.ingresos) + '</td>' +
    '<td class="num green">' + fmtMoney(r.net) + '</td></tr>'
  ).join('');
}

function renderAdDays() {
  const box = $('ad-days-list');
  const counts = {};
  // a day counts as "with sales" only if the OWNER sold that day
  dashSales.forEach(s => { if (s.seller_id === profile.id) counts[s.sale_date] = (counts[s.sale_date] || 0) + 1; });
  const rows = Object.keys(dashAd)
    .filter(d => !counts[d])
    .sort()
    .map(d => ({ date: d, amt: dashAd[d] }));
  const total = rows.reduce((a, r) => a + r.amt, 0);
  $('ad-unassigned').textContent = fmtMoney(total) + ' sin asignar';
  if (!rows.length) { box.innerHTML = '<div class="empty">Todo el gasto está asignado a días con ventas.</div>'; return; }
  box.innerHTML = rows.map(r =>
    '<div class="ad-row"><div><div class="ad-date">' + fmtLong(r.date) + '</div>' +
    '<div class="ad-src">Manual</div></div>' +
    '<div class="ad-amt">' + fmtMoney(r.amt) +
    '<span class="ad-warn">Sin ventas · gasto conservado en el día</span></div></div>'
  ).join('');
}

function renderHistory() {
  const box = $('history-list');
  if (!dashSales.length) { box.innerHTML = '<div class="empty">Sin ventas en el período.</div>'; return; }
  const adMap = isOwner() ? adPortionMap() : {};
  const bc = batchCountsOf(dashSales);
  box.innerHTML = dashSales.map(s =>
    saleCardHTML(s, { adPortion: adMap[s.sale_date] || 0, batchCount: s.batch_id ? (bc[s.batch_id] || 1) : 1 })).join('');
  bindSaleCardButtons(box);
}

/* ================= Modals ================= */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

async function saveAd() {
  const errBox = $('ad-error');
  errBox.classList.add('hidden');
  const date = $('ad-date').value;
  const amt = Math.max(0, Number($('ad-amount').value) || 0);
  if (!date) { errBox.textContent = 'Elige la fecha.'; errBox.classList.remove('hidden'); return; }
  const btn = $('ad-save');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const { error } = await sb.from('ad_spend')
      .upsert({ spend_date: date, amount_dop: amt }, { onConflict: 'spend_date' });
    if (error) throw error;
    closeModal('modal-ad-back');
    $('ad-amount').value = '';
    toast('Publicidad registrada.');
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    errBox.textContent = dbError(err, 'No se pudo guardar.');
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

/* ================= Bindings ================= */
function bindAll() {
  $('login-form').addEventListener('submit', handleLogin);

  $('nav-registrar').onclick = () => showView('registrar');
  $('nav-dashboard').onclick = () => showView('dashboard');
  $('btn-ver-panel').onclick = () => showView('dashboard');

  const doLogout = () => logout();
  $('btn-logout').onclick = doLogout;
  $('btn-logout-2').onclick = doLogout;

  const openPass = () => { $('pass-error').classList.add('hidden'); openModal('modal-pass-back'); };
  $('btn-change-pass').onclick = openPass;
  $('btn-change-pass-2').onclick = openPass;
  $('pass-cancel').onclick = () => closeModal('modal-pass-back');
  $('pass-save').onclick = changePassword;

  const refresh = () => {
    if (currentView === 'dashboard') loadDashboard();
    else { resetSaleForm(); loadRecent(); }
    toast('Actualizado.');
  };
  $('btn-refresh-sources').onclick = refresh;
  $('btn-refresh-all').onclick = refresh;

  // ad modal
  const openAd = () => {
    $('ad-error').classList.add('hidden');
    if (!$('ad-date').value) {
      $('ad-date').value = todayISO();
      $('ad-date-label').textContent = fmtDMY(todayISO());
    }
    openModal('modal-ad-back');
  };
  $('btn-reg-publicidad').onclick = openAd;
  $('btn-consultar-meta').onclick = openAd;
  $('ad-cancel').onclick = () => closeModal('modal-ad-back');
  $('ad-save').onclick = saveAd;

  // delete modal
  $('del-cancel').onclick = () => { deleteId = null; closeModal('modal-del-back'); };
  $('del-confirm').onclick = confirmDelete;

  // close modals on backdrop click
  document.querySelectorAll('.modal-back').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

  // dashboard filters
  $('period-pills').querySelectorAll('.pill').forEach(p =>
    p.onclick = () => {
      $('period-pills').querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      periodMode = p.dataset.p;
      if (periodMode === 'range' && (!rangeFromISO || !rangeToISO)) {
        rangeFromISO = refDateISO.slice(0, 7) + '-01';
        rangeToISO = todayISO();
      }
      syncFilterUI();
      loadDashboard();
    });
  $('ref-date-btn').addEventListener('click', () => pkOpenSingle('ref'));
  $('sale-date-btn').addEventListener('click', () => pkOpenSingle('sale'));
  $('ad-date-btn').addEventListener('click', () => pkOpenSingle('ad'));
  $('range-btn').addEventListener('click', () => pkOpen());
  $('pk-prev').addEventListener('click', () => { pkShiftView(-1); });
  $('pk-next').addEventListener('click', () => { pkShiftView(1); });
  $('pk-cancel').addEventListener('click', () => pkClose());
  $('pk-done').addEventListener('click', () => pkApply());
  $('picker-back').addEventListener('click', e => { if (e.target === $('picker-back')) pkClose(); });
  document.querySelectorAll('#pk-presets button').forEach(b =>
    b.addEventListener('click', () => {
      const [f, t] = pkPresetDates(b.dataset.pr);
      pkLastPreset = b.dataset.pr;
      if (pkMode === 'single') pkSetSingle(f); else pkSetRange(f, t);
    }));
  $('seller-filter').addEventListener('change', () => {
    sellerFilterId = $('seller-filter').value;
    loadDashboard();
  });
  $('analysis-tabs').querySelectorAll('.pill').forEach(p =>
    p.onclick = () => {
      $('analysis-tabs').querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      analysisTab = p.dataset.t;
      renderAnalysis();
    });
  $('chart-group-pills').querySelectorAll('.pill').forEach(p =>
    p.onclick = () => {
      $('chart-group-pills').querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      chartGroup = p.dataset.g;
      $('chart-eyebrow').textContent = chartGroup === 'year' ? 'Por año' :
        chartGroup === 'month' ? 'Por mes' : 'Por día';
      renderChart();
    });
  $('chart-metric-pills').querySelectorAll('.pill').forEach(p =>
    p.onclick = () => {
      $('chart-metric-pills').querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      chartMetric = p.dataset.m;
      renderChart();
    });

  bindSaleForm();
}

/* ================= Init ================= */
(async function init() {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  bindAll();
  $('ref-date').value = refDateISO;
  $('ad-date').value = todayISO();
  $('ad-date-label').textContent = fmtDMY(todayISO());
  setSaleDate(todayISO());
  syncFilterUI();
  try {
    if (await restoreSession()) await enterApp();
  } catch (err) {
    console.error(err);
  }
})();
