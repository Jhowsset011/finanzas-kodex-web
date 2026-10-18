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
  $('nav-registrar').classList.toggle('active', v === 'registrar');
  $('nav-dashboard').classList.toggle('active', v === 'dashboard');
  if (v === 'registrar') loadRecent();
  if (v === 'dashboard') loadDashboard();
}

async function enterApp() {
  $('topbar-user').textContent = profile.name + (isOwner() ? ' · Dueño' : ' · Vendedor');
  $('view-login').classList.add('hidden');
  $('view-main').classList.remove('hidden');
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
  const sel = $('sale-product');
  sel.innerHTML = '<option value="">Selecciona un producto</option>' +
    productsCache.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
}

function bindSaleForm() {
  const search = $('sale-search'), results = $('ac-results'), sel = $('sale-product');
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
      o.onclick = () => { selectProductById(o.dataset.id); results.classList.add('hidden'); search.value = ''; });
  });
  document.addEventListener('click', e => {
    if (!results.contains(e.target) && e.target !== search) results.classList.add('hidden');
  });
  sel.addEventListener('change', () => selectProductById(sel.value || null));
  ['sale-qty', 'sale-cost', 'sale-price', 'sale-ship'].forEach(id =>
    $(id).addEventListener('input', updateSummary));
  $('sale-save').onclick = saveSale;
  $('sale-cancel').onclick = resetSaleForm;
}

function selectProductById(id) {
  const p = id ? productById(id) : null;
  $('sale-product').value = p ? String(p.id) : '';
  $('sale-cost').value = p ? (p.cost_dop === 0 ? '' : Number(p.cost_dop)) : '';
  $('sale-cost').placeholder = p ? (p.cost_dop === 0 ? 'Pendiente — escríbelo' : '') : 'Pendiente';
  updateSummary();
}
function selectedProduct() {
  const id = $('sale-product').value;
  return id ? productById(id) : null;
}

function readSaleForm() {
  return {
    qty: Math.max(1, parseInt($('sale-qty').value, 10) || 1),
    cost: Math.max(0, Number($('sale-cost').value) || 0),
    price: Math.max(0, Number($('sale-price').value) || 0),
    ship: Math.max(0, Number($('sale-ship').value) || 0),
    date: $('sale-date').value || todayISO(),
    desc: $('sale-desc').value.trim().slice(0, 300),
  };
}

function updateSummary() {
  const f = readSaleForm();
  const venta = f.qty * f.price;
  const margin = venta - f.qty * f.cost - f.ship;
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
  $('sale-date').value = todayISO();
  $('reg-date-label').textContent = fmtLong(todayISO());
  $('sale-qty').value = '1';
  $('sale-search').value = '';
  $('sale-product').value = '';
  $('sale-cost').value = ''; $('sale-cost').placeholder = 'Pendiente';
  $('sale-price').value = '';
  $('sale-ship').value = '0';
  $('sale-desc').value = '';
  $('sale-error').classList.add('hidden');
  $('sale-save').textContent = 'Registrar venta';
  $('sale-cancel').classList.add('hidden');
  updateSummary();
}

async function saveSale() {
  const errBox = $('sale-error');
  errBox.classList.add('hidden');
  const p = selectedProduct();
  if (!p) { errBox.textContent = 'Busca y elige un producto primero.'; errBox.classList.remove('hidden'); return; }
  const f = readSaleForm();
  if (f.price <= 0) { errBox.textContent = 'Escribe el precio de venta.'; errBox.classList.remove('hidden'); return; }
  const btn = $('sale-save');
  btn.disabled = true; btn.textContent = 'Guardando…';
  const row = {
    seller_id: profile.id,
    product_id: p.id,
    quantity: f.qty,
    unit_sale_price_dop: f.price,
    shipping_cost_dop: f.ship,
    sale_date: f.date,
    description: f.desc,
  };
  const manualCost = (p.cost_dop === 0 && f.cost > 0) ? f.cost : 0;
  try {
    if (editingId) {
      const { error } = await sb.from('sales').update(row).eq('id', editingId);
      if (error) throw error;
      toast('Venta actualizada.');
    } else {
      const { error } = await sb.from('sales').insert(row);
      if (error) throw error;
      toast('Venta registrada.');
    }
    if (manualCost) {
      try {
        await sb.from('products').update({ cost_dop: manualCost }).eq('id', p.id);
        p.cost_dop = manualCost;
      } catch (_) { /* best effort: RLS may not allow */ }
    }
    resetSaleForm();
    loadRecent();
  } catch (err) {
    errBox.textContent = dbError(err, 'No se pudo guardar la venta.');
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = editingId ? 'Guardar cambios' : 'Registrar venta';
  }
}

function editSale(id) {
  const s = allSalesCache.find(x => x.id === id) || dashSales.find(x => x.id === id);
  if (!s) return;
  editingId = id;
  showView('registrar');
  $('sale-date').value = s.sale_date;
  $('sale-qty').value = s.quantity;
  const p = productById(s.product_id);
  $('sale-product').value = p ? String(p.id) : '';
  const cost = p ? Number(p.cost_dop) : 0;
  $('sale-cost').value = cost === 0 ? '' : cost;
  $('sale-price').value = s.unit_sale_price_dop;
  $('sale-ship').value = s.shipping_cost_dop;
  $('sale-desc').value = s.description || '';
  $('sale-save').textContent = 'Guardar cambios';
  $('sale-cancel').classList.remove('hidden');
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
  } finally {
    btn.disabled = false;
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
  $('ref-date-dmy').textContent = '· ' + fmtDMY($('ref-date').value || refDateISO);
  if (isRange) $('range-btn-label').textContent = fmtDMY(rangeFromISO) + ' – ' + fmtDMY(rangeToISO);
}

/* ============ Range picker (v7) ============ */
const MESES_LONG = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
  'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
let pkViewY = 0, pkViewM = 0;
let pkFrom = null, pkTo = null, pkLastPreset = null;

function pkOpen() {
  pkFrom = rangeFromISO; pkTo = rangeToISO; pkLastPreset = null;
  const [y, m] = pkTo.split('-').map(Number);
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
    if (pkFrom && pkTo) {
      if (iso === pkFrom && iso === pkTo) b.classList.add('single');
      else {
        if (iso === pkFrom) b.classList.add('range-start');
        if (iso === pkTo) b.classList.add('range-end');
        if (iso > pkFrom && iso < pkTo) b.classList.add('in-range');
      }
    } else if (pkFrom && iso === pkFrom) b.classList.add('single');
    b.addEventListener('click', () => pkPick(iso));
    grid.appendChild(b);
  }
  $('pk-from').textContent = fmtDMY(pkFrom);
  $('pk-to').textContent = fmtDMY(pkTo);
  document.querySelectorAll('#pk-presets button').forEach(x =>
    x.classList.toggle('active', x.dataset.pr === pkLastPreset));
}
function pkPick(iso) {
  pkLastPreset = null;
  if (!pkFrom || (pkFrom && pkTo)) { pkFrom = iso; pkTo = null; }
  else if (iso >= pkFrom) { pkTo = iso; }
  else { pkFrom = iso; }
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
  if (!pkFrom) { toast('Selecciona la fecha de inicio.', true); return; }
  rangeFromISO = pkFrom;
  rangeToISO = pkTo || pkFrom;
  pkClose();
  syncFilterUI();
  loadDashboard();
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
    let net = 0;
    dashSales.forEach(s => {
      const p = productById(s.product_id);
      const m = saleMargin(s, p ? Number(p.cost_dop) : 0);
      net += s.seller_id === profile.id ? m - (adMap[s.sale_date] || 0) : m / 2;
    });
    const marginPct = ventas > 0 ? (net / ventas * 100) : 0;
    row.innerHTML =
      statHTML('Ventas', fmtMoney(ventas), n + ' ventas · ' + units + ' unidades') +
      statHTML('Costo productos', fmtMoney(costo), '') +
      statHTML('Envíos', fmtMoney(envios), '') +
      statHTML('Publicidad', fmtMoney(adTotal), '') +
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

function renderHistory() {
  const box = $('history-list');
  if (!dashSales.length) { box.innerHTML = '<div class="empty">Sin ventas en el período.</div>'; return; }
  const adMap = isOwner() ? adPortionMap() : {};
  box.innerHTML = dashSales.map(s =>
    saleCardHTML(s, { adPortion: adMap[s.sale_date] || 0 })).join('');
  bindSaleCardButtons(box);
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
  $('ref-date').addEventListener('change', () => {
    if ($('ref-date').value) {
      refDateISO = $('ref-date').value;
      syncFilterUI();
      loadDashboard();
    }
  });
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
      pkSetRange(f, t);
    }));
  $('seller-filter').addEventListener('change', () => {
    sellerFilterId = $('seller-filter').value;
    loadDashboard();
  });

  bindSaleForm();
}

/* ================= Init ================= */
(async function init() {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  bindAll();
  $('ref-date').value = refDateISO;
  syncFilterUI();
  try {
    if (await restoreSession()) await enterApp();
  } catch (err) {
    console.error(err);
  }
})();
