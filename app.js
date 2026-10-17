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
  // persist manual cost for products without cost
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
  }
}

/* ================= Sale cards ================= */
let allSalesCache = [];   // recent sales (registrar view)

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
  paintPaidButton(btn, newPaid);                       // instant UI
  const cached = findSaleInCache(saleId);
  if (cached) cached.paid = newPaid;
  btn.disabled = true;
  try {
    const { error } = await sb.from('sales').update({ paid: newPaid }).eq('id', saleId);
    if (error) throw error;
    toast(newPaid ? 'Venta marcada como pagada.' : 'Venta marcada como pendiente de pago.');
  } catch (err) {
    if (cached) cached.paid = currentlyPaid;
    paintPaidButton(btn, currentlyPaid);
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
    box.innerHTML = allSalesCache.map(s => {
      let adP = 0;
      if (isOwner()) {
        const amt = Number(adMap[s.sale_date]) || 0;
        const n = dayCounts[s.sale_date] || 1;
        adP = amt / n;
      }
      return saleCardHTML(s, { adPortion: adP });
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
  $('ref-date-dmy').textContent = '· ' + fmtDMY($('ref-date').value || refDateISO);
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
  $('chart-eyebrow').textContent = periodMode === 'day' ? 'Por hora' :
    periodMode === 'year' ? 'Por mes' : 'Por día';
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

function renderChart() {
  const box = $('chart');
  const W = 640, H = 300, PL = 44, PB = 30, PT = 8;
  const buckets = [];
  if (periodMode === 'day') {
    buckets.push({ label: refDateISO.slice(8, 10), total: periodTotal(s => s.sale_date === refDateISO) });
  } else if (periodMode === 'range') {
    let cur = rangeFromISO, guard = 0;
    while (cur <= rangeToISO && guard < 366) {
      buckets.push({ label: cur.slice(8, 10), total: periodTotal(s => s.sale_date === cur) });
      cur = addDays(cur, 1);
      guard++;
    }
  } else if (periodMode === 'year') {
    const y = refDateISO.slice(0, 4);
    for (let m = 1; m <= 12; m++) {
      const ym = y + '-' + String(m).padStart(2, '0');
      buckets.push({ label: MESES[m - 1], total: periodTotal(s => s.sale_date.slice(0, 7) === ym) });
    }
  } else {
    const ym = refDateISO.slice(0, 7);
    const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    for (let d = 1; d <= dim; d++) {
      const dt = ym + '-' + String(d).padStart(2, '0');
      const t = periodTotal(s => s.sale_date === dt);
      if (t > 0 || dim <= 31) buckets.push({ label: String(d), total: t, show: t > 0 });
    }
  }
  const shown = buckets.filter(b => b.show !== false);
  const max = Math.max(1, ...shown.map(b => b.total));
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const iw = W - PL - 8, ih = H - PT - PB;
  const bw = Math.min(120, (iw / Math.max(1, shown.length)) * 0.55);
  let svg = '<svg class="bar-chart" viewBox="0 0 ' + W + ' ' + H + '">';
  for (let v = 0; v <= yMax; v += step) {
    const y = PT + ih - (v / yMax) * ih;
    svg += '<line x1="' + PL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="#1a222c" stroke-width="1"/>' +
      '<text x="' + (PL - 8) + '" y="' + (y + 4) + '" fill="#5d6672" font-size="11" text-anchor="end">' +
      (v >= 1000 ? (v / 1000) + ' K' : v) + '</text>';
  }
  shown.forEach((b, i) => {
    const h = (b.total / yMax) * ih;
    const x = PL + (iw / shown.length) * i + ((iw / shown.length) - bw) / 2;
    const y = PT + ih - h;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
      '" height="' + Math.max(0, h).toFixed(1) + '" rx="5" fill="#22c55e"/>';
    if (shown.length <= 31) {
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" fill="#5d6672" font-size="11" text-anchor="middle">' + b.label + '</text>';
    }
  });
  svg += '</svg>';
  box.innerHTML = svg;
}
function periodTotal(fn) {
  return dashSales.filter(fn).reduce((a, s) =>
    a + (Number(s.quantity) || 0) * (Number(s.unit_sale_price_dop) || 0), 0);
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
  box.innerHTML = dashSales.map(s =>
    saleCardHTML(s, { adPortion: adMap[s.sale_date] || 0 })).join('');
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
    if (!$('ad-date').value) $('ad-date').value = todayISO();
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
        $('range-from').value = rangeFromISO;
        $('range-to').value = rangeToISO;
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
  const onRangeChange = which => {
    const fromEl = $('range-from'), toEl = $('range-to');
    const prev = which === 'from' ? rangeFromISO : rangeToISO;
    const val = which === 'from' ? fromEl.value : toEl.value;
    if (!val) return;
    if (which === 'from') rangeFromISO = val; else rangeToISO = val;
    if (rangeFromISO && rangeToISO && rangeFromISO > rangeToISO) {
      if (which === 'from') { rangeFromISO = prev; fromEl.value = prev; }
      else { rangeToISO = prev; toEl.value = prev; }
      toast('La fecha "Desde" debe ser anterior o igual a "Hasta".', true);
      return;
    }
    loadDashboard();
  };
  $('range-from').addEventListener('change', () => onRangeChange('from'));
  $('range-to').addEventListener('change', () => onRangeChange('to'));
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

  bindSaleForm();
}

/* ================= Init ================= */
(async function init() {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  bindAll();
  $('ref-date').value = refDateISO;
  $('range-from').value = rangeFromISO;
  $('range-to').value = rangeToISO;
  syncFilterUI();
  try {
    if (await restoreSession()) await enterApp();
  } catch (err) {
    console.error(err);
  }
})();
