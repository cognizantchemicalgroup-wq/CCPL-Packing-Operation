// CCPL Operations System — logic of CCPL_Inventory_V5.html, stored in Firebase (Auth + Firestore).
// Additions: supplier / product / packaging-material masters, material + packing standard per ready box,
// litres and kg on dispatch.
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, reload, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, getFirestore, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';

/* ------------------------------------------------------------------ Firebase */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const firebaseReady = Object.values(firebaseConfig).every(Boolean);
const app = firebaseReady ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

const ADMIN_EMAIL = 'rupesh.mudlar@cognizantchemical.com';
const ALLOWED_EMAILS = [ADMIN_EMAIL, 'indra@cognizantchemical.com', 'production@cognizantchemical.com', 'qa@cognizantchemical.com', 'anzarsayyed02@gmail.com'];
const ROOT = 'companies/ccpl';
const ref = (p) => doc(db, `${ROOT}/${p}`);
const col = (p) => collection(db, `${ROOT}/${p}`);
const newRef = (p) => doc(col(p));
const STOCK = () => ref('stock/packaging');
const TOTALS = () => ref('stock/totals');
const COUNTERS = () => ref('counters/main');

/* ------------------------------------------------------------------ Masters (defaults, seeded once) */
const DEFAULT_SUPPLIERS = ['ABC Chemicals', 'Deepak Fertilisers and Petrochemicals Corporation Ltd.', 'Demo Supplier'];
const DEFAULT_PRODUCTS = [
  { id: 'IPA', name: 'Isopropyl Alcohol', density: 0.785 },
  { id: 'METHANOL', name: 'Methanol', density: 0.792 },
  { id: 'ACETONITRILE', name: 'Acetonitrile', density: 0.786 },
  { id: 'ACETONE', name: 'Acetone', density: 0.791 },
  { id: 'DCM', name: 'Dichloromethane', density: 1.326 },
];
const DEFAULT_PACK = [
  { id: 'BOTTLE_2_5L', name: '2.5 L Bottle', role: 'container', capacity: 2.5, unit: 'L', perBox: 4, lowAlert: 50, order: 1 },
  { id: 'EMPTY_BOX', name: 'Empty Box', role: 'accessory', capacity: 0, unit: 'L', perBox: 1, lowAlert: 50, order: 2 },
  { id: 'BOX_PLATE', name: 'Box Plate / Partition', role: 'accessory', capacity: 0, unit: 'L', perBox: 2, lowAlert: 50, order: 3 },
  { id: 'THERMOCOL', name: 'Thermocol', role: 'accessory', capacity: 0, unit: 'L', perBox: 2, lowAlert: 50, order: 4 },
];
const LOCATIONS = ['RM Warehouse', 'Tank Farm - RM Tank 01', 'Tank Farm - RM Tank 02', 'Tank Farm - RM Tank 03', 'QC Hold Area', 'Taloja Warehouse', 'Patalganga Plant'];

/* ------------------------------------------------------------------ State (live from Firestore) */
let state = { inwards: [], suppliers: [], products: [], packMaterials: [], stock: {}, totals: {}, readyBatches: [], txns: [] };
let currentUser = null;
let isAdmin = false;
let currentView = 'dashboardView';
let currentPacking = 'DRUMS';
let selectedInwardId = null;
let renderedDetailKey = '';
let editingPackId = null;
let unsubs = [];

/* ------------------------------------------------------------------ Helpers (from V5) */
const $ = (id) => document.getElementById(id);
const num = (n) => Number(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
function moneyish(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function nowISO() { return new Date().toISOString(); }
function formatDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function localDay(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function yymm() { const d = new Date(); return `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}`; }
function statusOf(i) {
  if (i.grn?.finalized) return 'GRN_COMPLETED';
  if (i.kanta?.net != null) return 'GRN_PENDING';
  return 'KANTA_PENDING';
}
function statusBadge(i) {
  const s = statusOf(i);
  if (s === 'GRN_COMPLETED') return `<span class="badge done">GRN COMPLETED</span>`;
  if (s === 'GRN_PENDING') return `<span class="badge review">GRN PENDING</span>`;
  return `<span class="badge pending">KANTA PENDING</span>`;
}
let toastTimer;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
const by = () => currentUser?.email || '';

/* ------------------------------------------------------------------ Navigation (from V5) */
function go(viewId) {
  currentView = viewId;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.go === viewId));
  if (viewId === 'dashboardView') renderDashboard();
  if (viewId === 'inwardsView') renderInwards();
  if (viewId === 'packagingView') renderPackaging();
  if (viewId === 'mastersView') renderMasters();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => go(el.dataset.go)));

/* ------------------------------------------------------------------ Master lookups */
const activeList = (arr) => arr.filter((x) => x.active !== false);
const chemicals = () => activeList(state.products);
const packItems = () => activeList(state.packMaterials).sort((a, b) => num(a.order || 99) - num(b.order || 99) || a.name.localeCompare(b.name));
const containers = () => packItems().filter((m) => m.role === 'container');
const accessories = () => packItems().filter((m) => m.role === 'accessory');
const packName = (id) => state.packMaterials.find((m) => m.id === id)?.name || id;

/** Litres / kg held by one finished box packed with this container. */
function fillPerBox(container, density) {
  if (!container) return { litres: 0, kg: 0 };
  const amount = num(container.capacity) * num(container.perBox);
  const d = num(density);
  if (container.unit === 'kg') return { kg: amount, litres: d ? amount / d : 0 };
  return { litres: amount, kg: amount * d };
}
/** Packaging used per box: the chosen container + every active box accessory. */
function perBoxConsumption(container) {
  const out = {};
  if (container && num(container.perBox) > 0) out[container.id] = num(container.perBox);
  accessories().forEach((m) => { if (num(m.perBox) > 0) out[m.id] = (out[m.id] || 0) + num(m.perBox); });
  return out;
}
const scale = (perBox, boxes) => Object.fromEntries(Object.entries(perBox || {}).map(([k, q]) => [k, num(q) * num(boxes)]));

/* ------------------------------------------------------------------ Selects (from V5 initSelects, now from masters) */
function keepValue(sel, html) { const cur = sel.value; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === cur)) sel.value = cur; }
function initSelects() {
  keepValue($('supplier'), `<option value="">Select supplier</option>` + activeList(state.suppliers).map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('') + `<option value="__new">＋ Add new supplier…</option>`);
  keepValue($('product'), `<option value="">Select product</option>` +
    `<optgroup label="CHEMICALS">${chemicals().map((x) => `<option value="chem:${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>` +
    `<optgroup label="PACKAGING MATERIALS">${packItems().map((x) => `<option value="pack:${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>` +
    `<option value="__new">＋ Add new product…</option>`);
  keepValue($('location'), `<option value="">Select location</option>` + LOCATIONS.map((x) => `<option>${x}</option>`).join(''));
  $('supplierDatalist').innerHTML = activeList(state.suppliers).map((x) => `<option value="${esc(x.name)}">`).join('');
}

function getSelectedProduct() {
  const [kind, id] = ($('product').value || '').split(':');
  if (kind === 'chem') { const p = state.products.find((x) => x.id === id); return p ? { ...p, category: 'CHEMICAL' } : null; }
  if (kind === 'pack') { const p = state.packMaterials.find((x) => x.id === id); return p ? { ...p, category: 'PACKAGING' } : null; }
  return null;
}
function getSelectedDensity() { const p = getSelectedProduct(); return p?.category === 'CHEMICAL' ? num(p.density) : 0; }
function isPackagingProduct() { return getSelectedProduct()?.category === 'PACKAGING'; }
function updateProductMode() {
  const packaging = isPackagingProduct();
  $('receivedAsBlock')?.classList.toggle('hidden', packaging);
  const kantaRow = $('kantaAvailable')?.closest('.top-gap');
  if (kantaRow) kantaRow.classList.toggle('hidden', packaging);
  $('instantKantaFields')?.classList.add('hidden');
  $('declaredLabel').textContent = packaging ? 'Received Quantity' : 'Declared Quantity';
  $('declaredHelper').textContent = packaging ? 'Packaging stock will be added automatically in Nos.' : 'Calculated automatically from packing.';
  renderPackingFields();
}

function renderPackingFields() {
  const box = $('packingFields');
  if (isPackagingProduct()) {
    box.innerHTML = `<label>Quantity (Nos.)<input type="number" min="1" step="1" id="packagingQty" placeholder="Enter quantity" required></label>`;
    box.querySelectorAll('input,select').forEach((x) => x.addEventListener('input', updateDeclared));
    updateDeclared();
    return;
  }
  if (currentPacking === 'DRUMS') {
    box.innerHTML = `
      <label>No. of Drums<input type="number" min="1" step="1" id="count" value="30" required></label>
      <label>Qty / Drum (kg)<input type="number" min="0" step="0.01" id="perQty" value="160" required></label>`;
  } else if (currentPacking === 'IBC') {
    box.innerHTML = `
      <label>No. of IBCs<input type="number" min="1" step="1" id="count" value="10" required></label>
      <label>Qty / IBC (L)<input type="number" min="0" step="0.01" id="perQty" value="1000" required></label>
      <label>Density (kg/L)<input type="number" min="0" step="0.001" id="density" value="${getSelectedDensity() || 0.792}" required></label>`;
  } else if (currentPacking === 'TANKER') {
    box.innerHTML = `
      <label>Invoice Quantity<input type="number" min="0" step="0.01" id="invoiceQty" value="20000" required></label>
      <label>Invoice Unit<select id="invoiceUnit"><option value="L">Litres</option><option value="KL">KL</option><option value="KG">kg</option></select></label>
      <label>Density (kg/L)<input type="number" min="0" step="0.001" id="density" value="${getSelectedDensity() || 0.792}" required></label>`;
  } else {
    box.innerHTML = `
      <label>Quantity<input type="number" min="0" step="0.01" id="otherQty" required></label>
      <label>Unit<select id="otherUnit"><option value="KG">kg</option><option value="L">Litres</option><option value="KL">KL</option></select></label>
      <label>Density (kg/L)<input type="number" min="0" step="0.001" id="density" value="${getSelectedDensity() || 0.792}"></label>`;
  }
  box.querySelectorAll('input,select').forEach((x) => x.addEventListener('input', updateDeclared));
  updateDeclared();
}

function calculateDeclared() {
  if (isPackagingProduct()) {
    const qty = Number($('packagingQty')?.value || 0);
    return { kg: qty, count: qty, displayUnit: 'Nos.' };
  }
  const d = getSelectedDensity() || Number($('density')?.value || 0);
  if (currentPacking === 'DRUMS') {
    return { kg: Number($('count')?.value || 0) * Number($('perQty')?.value || 0), displayUnit: 'kg' };
  }
  if (currentPacking === 'IBC') {
    const litres = Number($('count')?.value || 0) * Number($('perQty')?.value || 0);
    const density = Number($('density')?.value || d || 0);
    return { kg: litres * density, litres, displayUnit: 'L' };
  }
  if (currentPacking === 'TANKER') {
    const qty = Number($('invoiceQty')?.value || 0);
    const unit = $('invoiceUnit')?.value || 'L';
    const density = Number($('density')?.value || d || 0);
    let kg = qty;
    let litres = null;
    if (unit === 'L') { litres = qty; kg = qty * density; }
    if (unit === 'KL') { litres = qty * 1000; kg = litres * density; }
    return { kg, litres, displayUnit: unit };
  }
  const qty = Number($('otherQty')?.value || 0);
  const unit = $('otherUnit')?.value || 'KG';
  const density = Number($('density')?.value || d || 0);
  let kg = qty, litres = null;
  if (unit === 'L') { litres = qty; kg = qty * density; }
  if (unit === 'KL') { litres = qty * 1000; kg = litres * density; }
  return { kg, litres, displayUnit: unit };
}
function updateDeclared() {
  const q = calculateDeclared();
  let text = isPackagingProduct() ? `${moneyish(q.count || 0)} Nos.` : `${moneyish(q.kg)} kg`;
  if (!isPackagingProduct() && q.litres != null) text += ` (${moneyish(q.litres)} L)`;
  $('declaredQtyText').textContent = text;
}

/* "＋ Add new …" straight from the inward selects */
$('supplier').addEventListener('change', async (e) => {
  if (e.target.value !== '__new') return;
  e.target.value = '';
  const name = prompt('New supplier name');
  if (!name?.trim()) return;
  if (await addSupplier(name.trim(), '')) { initSelects(); $('supplier').value = name.trim(); }
});
$('product').addEventListener('change', async (e) => {
  if (e.target.value === '__new') {
    e.target.value = '';
    const name = prompt('New product name (chemical)');
    if (!name?.trim()) return;
    const density = prompt(`Density of ${name.trim()} in kg/L (e.g. 0.792)`);
    if (density === null) return;
    const id = await addProduct(name.trim(), density);
    if (id) { initSelects(); $('product').value = `chem:${id}`; }
  }
  updateProductMode();
  const densityEl = $('density');
  if (densityEl) densityEl.value = getSelectedDensity() || densityEl.value;
  updateDeclared();
});
document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentPacking = btn.dataset.type;
    document.querySelectorAll('.seg').forEach((x) => x.classList.toggle('active', x === btn));
    renderPackingFields();
  });
});
$('kantaAvailable').addEventListener('change', (e) => {
  $('instantKantaFields').classList.toggle('hidden', !e.target.checked);
});

/* ------------------------------------------------------------------ Inward submit (V5 logic, saved to Firestore) */
$('inwardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const declared = calculateDeclared();
  if (!declared.kg || declared.kg <= 0) { showToast('Enter a valid quantity.'); return; }
  const productMeta = getSelectedProduct();
  if (!productMeta) { showToast('Select a product.'); return; }

  if (isPackagingProduct()) {
    const qty = Number(declared.count || 0);
    try {
      await addPackagingInward({
        itemKey: productMeta.id, qty,
        invoiceNo: $('invoiceNo').value.trim(),
        supplier: $('supplier').value,
        vehicleNo: $('vehicleNo').value.trim().toUpperCase(),
        location: $('location').value,
      });
      e.target.reset();
      currentPacking = 'DRUMS';
      document.querySelectorAll('.seg').forEach((x) => x.classList.toggle('active', x.dataset.type === 'DRUMS'));
      updateProductMode();
      showToast(`${productMeta.name}: ${moneyish(qty)} Nos. added to packaging stock`);
      go('packagingView');
    } catch (error) {
      console.error('Packaging inward failed:', error);
      showToast('Database save failed: ' + (error.message || 'Unknown error'));
    }
    return;
  }

  const inward = {
    createdAt: nowISO(),
    supplier: $('supplier').value,
    product: productMeta.name,
    productId: productMeta.id,
    vehicleNo: $('vehicleNo').value.trim().toUpperCase(),
    invoiceNo: $('invoiceNo').value.trim(),
    supplierLot: $('supplierLot').value.trim(),
    location: $('location').value,
    packingType: currentPacking,
    declaredKg: declared.kg,
    declaredLitres: declared.litres ?? null,
    packing: {},
    documents: {
      invoiceName: $('invoiceFile').files[0]?.name || '',
      coaName: $('coaFile').files[0]?.name || '',
    },
    kanta: null,
    grn: { finalized: false },
    audit: [{ at: nowISO(), action: 'INWARD_CREATED', by: by() }],
    createdBy: by(),
  };
  if (currentPacking === 'DRUMS' || currentPacking === 'IBC') {
    inward.packing.count = Number($('count').value);
    inward.packing.perQty = Number($('perQty').value);
  } else if (currentPacking === 'TANKER') {
    inward.packing.invoiceQty = Number($('invoiceQty').value);
    inward.packing.invoiceUnit = $('invoiceUnit').value;
  }
  if ($('density')) inward.packing.density = Number($('density').value || 0);
  if ($('kantaAvailable').checked) {
    const gross = Number($('grossWeightNow').value || 0);
    const tare = Number($('tareWeightNow').value || 0);
    if (gross > 0 && tare >= 0 && gross >= tare) {
      inward.kanta = { gross, tare, net: gross - tare, addedAt: nowISO(), slipName: '' };
      inward.audit.push({ at: nowISO(), action: 'KANTA_ADDED', by: by() });
    }
  }

  try {
    const r = newRef('inwards');
    const no = await runTransaction(db, async (tx) => {
      const c = await tx.get(COUNTERS());
      const seq = num(c.data()?.inward) + 1;
      const inwardNo = `INW-${yymm()}-${String(seq).padStart(4, '0')}`;
      tx.set(COUNTERS(), { inward: seq }, { merge: true });
      tx.set(r, { ...inward, inwardNo });
      return inwardNo;
    });
    e.target.reset();
    currentPacking = 'DRUMS';
    document.querySelectorAll('.seg').forEach((x) => x.classList.toggle('active', x.dataset.type === 'DRUMS'));
    renderPackingFields();
    $('instantKantaFields').classList.add('hidden');
    showToast(`${no} created`);
    go('dashboardView');
  } catch (error) {
    console.error(error);
    showToast('Database save failed: ' + (error.message || 'Unknown error'));
  }
});

/* ------------------------------------------------------------------ Dashboard / register / detail (from V5) */
function renderDashboard() {
  const today = localDay();
  const items = state.inwards;
  $('todayInwards').textContent = items.filter((i) => localDay(new Date(i.createdAt)) === today).length;
  $('kantaPending').textContent = items.filter((i) => statusOf(i) === 'KANTA_PENDING').length;
  $('grnPending').textContent = items.filter((i) => statusOf(i) === 'GRN_PENDING').length;
  $('grnCompleted').textContent = items.filter((i) => statusOf(i) === 'GRN_COMPLETED').length;
  renderList(items.slice(0, 5), $('recentInwards'));
  renderPackagingCards($('dashboardPackaging'));
  renderSoldSummary($('dashSold'));
}
function renderList(items, target) {
  if (!items.length) { target.innerHTML = `<div class="empty">No inward records yet.</div>`; return; }
  target.innerHTML = items.map((i) => `
    <div class="list-item" data-open="${i.id}">
      <div>
        <div class="item-title">${esc(i.inwardNo)} · ${esc(i.product)}</div>
        <div class="item-sub">${esc(i.supplier)}<br>${moneyish(i.declaredKg)} kg · ${esc(i.packingType)} · ${formatDateTime(i.createdAt)}</div>
      </div>
      <div>${statusBadge(i)}</div>
    </div>
  `).join('');
  target.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openDetail(el.dataset.open)));
}
function renderInwards() {
  const q = ($('searchInward').value || '').toLowerCase().trim();
  const f = $('statusFilter').value;
  const items = state.inwards.filter((i) => {
    const hay = [i.inwardNo, i.product, i.supplier, i.invoiceNo, i.vehicleNo].join(' ').toLowerCase();
    return (!q || hay.includes(q)) && (f === 'ALL' || statusOf(i) === f);
  });
  renderList(items, $('inwardsList'));
}
$('searchInward').addEventListener('input', renderInwards);
$('statusFilter').addEventListener('change', renderInwards);

function openDetail(id) {
  selectedInwardId = id;
  const i = state.inwards.find((x) => x.id === id);
  if (!i) return;
  renderedDetailKey = `${id}:${statusOf(i)}`;
  $('detailTitle').textContent = i.inwardNo;
  const diff = i.kanta ? i.kanta.net - i.declaredKg : null;
  const diffPct = i.kanta && i.declaredKg ? (diff / i.declaredKg * 100) : null;
  let diffClass = 'diff-match', diffLabel = 'Matched';
  if (diff < 0) { diffClass = 'diff-short'; diffLabel = 'Shortage'; }
  if (diff > 0) { diffClass = 'diff-excess'; diffLabel = 'Excess'; }

  let actionBlock = '';
  if (!i.kanta) {
    actionBlock = `
      <div class="detail-card">
        <div class="field-title">Add Kanta / Weighment</div>
        <div class="form-grid">
          <label>Gross Weight (kg)<input type="number" id="detailGross" step="0.01"></label>
          <label>Tare Weight (kg)<input type="number" id="detailTare" step="0.01"></label>
          <label>Kanta Slip<input type="file" id="detailKantaFile" accept="image/*,.pdf"></label>
        </div>
        <button class="primary big-action" id="saveKantaBtn">Save Kanta</button>
      </div>`;
  } else if (!i.grn?.finalized) {
    actionBlock = `
      <div class="detail-card">
        <div class="field-title">Kanta Reconciliation</div>
        <div class="recon">
          <div class="recon-row"><span>Declared / Invoice Qty</span><strong>${moneyish(i.declaredKg)} kg</strong></div>
          <div class="recon-row"><span>Kanta Net Qty</span><strong>${moneyish(i.kanta.net)} kg</strong></div>
          <div class="recon-row total ${diffClass}"><span>${diffLabel}</span><strong>${diff >= 0 ? '+' : ''}${moneyish(diff)} kg (${diffPct >= 0 ? '+' : ''}${moneyish(diffPct)}%)</strong></div>
        </div>
        <div class="form-grid top-gap">
          <label>Final Accepted Qty (kg)<input type="number" id="acceptedQty" step="0.01" value="${i.kanta.net}"></label>
          <label>Remarks<input id="grnRemarks" placeholder="Shortage / excess / accepted as per Kanta"></label>
        </div>
        <button class="primary big-action" id="finalizeGrnBtn">Finalize GRN</button>
      </div>`;
  } else {
    actionBlock = `
      <div class="detail-card">
        <div class="field-title">Final GRN</div>
        <div class="detail-grid">
          <div class="kv"><span>GRN No.</span><strong>${esc(i.grn.grnNo)}</strong></div>
          <div class="kv"><span>Accepted Qty</span><strong>${moneyish(i.grn.acceptedKg)} kg</strong></div>
          <div class="kv"><span>Finalized</span><strong>${formatDateTime(i.grn.finalizedAt)}</strong></div>
          <div class="kv"><span>Remarks</span><strong>${esc(i.grn.remarks) || '—'}</strong></div>
        </div>
      </div>`;
  }

  $('detailBody').innerHTML = `
    <div class="detail-card">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:14px">
        <strong>${esc(i.product)}</strong>${statusBadge(i)}
      </div>
      <div class="detail-grid">
        <div class="kv"><span>Supplier</span><strong>${esc(i.supplier)}</strong></div>
        <div class="kv"><span>Invoice</span><strong>${esc(i.invoiceNo)}</strong></div>
        <div class="kv"><span>Vehicle</span><strong>${esc(i.vehicleNo)}</strong></div>
        <div class="kv"><span>Supplier Lot</span><strong>${esc(i.supplierLot) || '—'}</strong></div>
        <div class="kv"><span>Packing</span><strong>${esc(i.packingType)}</strong></div>
        <div class="kv"><span>Receiving Location</span><strong>${esc(i.location)}</strong></div>
        <div class="kv"><span>Declared Qty</span><strong>${moneyish(i.declaredKg)} kg</strong></div>
        <div class="kv"><span>Received</span><strong>${formatDateTime(i.createdAt)}</strong></div>
      </div>
    </div>
    ${i.kanta ? `
      <div class="detail-card">
        <div class="field-title">Weighment</div>
        <div class="detail-grid">
          <div class="kv"><span>Gross</span><strong>${moneyish(i.kanta.gross)} kg</strong></div>
          <div class="kv"><span>Tare</span><strong>${moneyish(i.kanta.tare)} kg</strong></div>
          <div class="kv"><span>Net</span><strong>${moneyish(i.kanta.net)} kg</strong></div>
          <div class="kv"><span>Kanta Slip</span><strong>${esc(i.kanta.slipName) || 'Not attached'}</strong></div>
        </div>
      </div>` : ''}
    ${actionBlock}
  `;

  if (!i.kanta) $('saveKantaBtn').addEventListener('click', saveKanta);
  else if (!i.grn?.finalized) $('finalizeGrnBtn').addEventListener('click', finalizeGrn);
  if (currentView !== 'detailView') go('detailView');
}
async function saveKanta() {
  const gross = Number($('detailGross').value || 0);
  const tare = Number($('detailTare').value || 0);
  if (gross <= 0 || tare < 0 || tare > gross) { showToast('Check gross and tare weights.'); return; }
  const slip = $('detailKantaFile').files[0]?.name || '';
  const r = ref(`inwards/${selectedInwardId}`);
  try {
    await runTransaction(db, async (tx) => {
      const s = await tx.get(r);
      if (!s.exists()) throw new Error('Inward not found.');
      const i = s.data();
      if (i.kanta?.net != null) throw new Error('Kanta already saved for this inward.');
      tx.update(r, { kanta: { gross, tare, net: gross - tare, addedAt: nowISO(), slipName: slip }, audit: [...(i.audit || []), { at: nowISO(), action: 'KANTA_ADDED', gross, tare, net: gross - tare, by: by() }] });
    });
    showToast('Kanta saved');
  } catch (error) { showToast(error.message); }
}
async function finalizeGrn() {
  const accepted = Number($('acceptedQty').value || 0);
  if (accepted <= 0) { showToast('Enter accepted quantity.'); return; }
  const remarks = $('grnRemarks').value.trim();
  const r = ref(`inwards/${selectedInwardId}`);
  try {
    const no = await runTransaction(db, async (tx) => {
      const [s, c] = await Promise.all([tx.get(r), tx.get(COUNTERS())]);
      if (!s.exists()) throw new Error('Inward not found.');
      const i = s.data();
      if (i.grn?.finalized) throw new Error('GRN already finalized.');
      const seq = num(c.data()?.grn) + 1;
      const grnNo = `GRN-${yymm()}-${String(seq).padStart(4, '0')}`;
      tx.set(COUNTERS(), { grn: seq }, { merge: true });
      tx.update(r, {
        grn: { finalized: true, grnNo, acceptedKg: accepted, remarks, finalizedAt: nowISO(), reconciliationKg: accepted - i.declaredKg },
        audit: [...(i.audit || []), { at: nowISO(), action: 'GRN_FINALIZED', acceptedKg: accepted, grnNo, by: by() }],
      });
      return grnNo;
    });
    showToast(`${no} finalized`);
  } catch (error) { showToast(error.message); }
}

/* ------------------------------------------------------------------ Packaging (V5 logic, now in Firestore transactions) */
function renderPackagingCards(target) {
  if (!target) return;
  const items = packItems();
  if (!items.length) { target.innerHTML = '<div class="empty">No packaging materials. Add them in Masters.</div>'; return; }
  target.innerHTML = items.map((m) => {
    const q = num(state.stock[m.id]);
    const low = q < num(m.lowAlert ?? 50);
    return `<div class="pack-card ${low ? 'low' : 'ok'}"><div class="stat-label">${esc(m.name)}</div><div class="qty">${moneyish(q)}</div><div class="mini">Available Nos.</div></div>`;
  }).join('');
}
function renderSoldSummary(target) {
  if (!target) return;
  const t = state.totals || {};
  const rows = Object.values(t.byProduct || {}).filter((p) => num(p.boxes) > 0);
  target.innerHTML = `<div class="stat-label">TOTAL SOLD / DISPATCHED</div>
    <strong>${moneyish(t.litres)} L</strong>
    <div class="mini">≈ ${moneyish(t.kg)} kg · ${moneyish(t.boxes)} boxes · kg shown for knowledge (litres × density)</div>
    ${rows.length ? `<div class="sold-rows">${rows.map((p) => `<div><span>${esc(p.name)} · ${moneyish(p.boxes)} boxes</span><strong>${moneyish(p.litres)} L ≈ ${moneyish(p.kg)} kg</strong></div>`).join('')}</div>` : ''}`;
}
function readyRemaining(b) { return Math.max(0, Number(b.readyBoxes || 0) - Number(b.dispatchedBoxes || 0)); }
function batchLabel(b) { return `${b.productName || b.product}${b.batchNo ? ' / Batch ' + b.batchNo : ''}`; }

function renderConsumptionPreview() {
  const el = $('packConsumptionPreview'); if (!el) return;
  const id = $('dispatchReadyId')?.value;
  const batch = state.readyBatches.find((x) => x.id === id);
  const boxes = Number($('packOutBoxes')?.value || 0);
  if (!batch) { el.innerHTML = '<div><span>Select a ready batch</span><strong>—</strong></div>'; return; }
  const remain = readyRemaining(batch);
  el.innerHTML = `<div><span>Material in box</span><strong>${esc(batch.productName || batch.product)}</strong></div>
    <div><span>Ready balance</span><strong>${moneyish(remain)} boxes</strong></div>
    <div><span>After this dispatch</span><strong>${moneyish(Math.max(0, remain - boxes))} boxes</strong></div>
    <div><span>${moneyish(boxes)} boxes × ${moneyish(batch.unitsPerBox)} × ${esc(batch.containerName || '')}</span><strong>${moneyish(boxes * num(batch.unitsPerBox))} Nos.</strong></div>
    <div><span>Total litres going out</span><strong>${moneyish(boxes * num(batch.litresPerBox))} L</strong></div>
    <div><span>≈ Total kg (for knowledge)</span><strong>${moneyish(boxes * num(batch.kgPerBox))} kg</strong></div>
    <div><span>Packaging deduction</span><strong>Already consumed when packed</strong></div>`;
}
function renderReadyConsumptionPreview() {
  const el = $('readyConsumptionPreview'); if (!el) return;
  const boxes = Number($('readyBoxes')?.value || 0);
  const product = state.products.find((p) => p.id === $('readyMaterial')?.value);
  const container = state.packMaterials.find((m) => m.id === $('readyContainer')?.value);
  const fill = fillPerBox(container, product?.density);
  const need = scale(perBoxConsumption(container), boxes);
  el.innerHTML = '<div class="field-title">Material packed</div>' +
    `<div><span>1 box = ${container ? `${moneyish(container.perBox)} × ${moneyish(container.capacity)} ${container.unit === 'kg' ? 'kg' : 'L'}` : '—'}</span><strong>${moneyish(fill.litres)} L${product ? ` ≈ ${moneyish(fill.kg)} kg` : ''}</strong></div>` +
    `<div><span>${moneyish(boxes)} boxes${product ? ' of ' + esc(product.name) : ''}</span><strong>${moneyish(fill.litres * boxes)} L${product ? ` ≈ ${moneyish(fill.kg * boxes)} kg` : ''}</strong></div>` +
    '<div class="field-title" style="margin-top:8px">Packaging consumed when marked ready</div>' +
    Object.entries(need).map(([k, q]) => `<div class="${num(state.stock[k]) < q ? 'danger-text' : ''}"><span>${esc(packName(k))}</span><strong>− ${moneyish(q)}</strong></div>`).join('');
}
function renderReadyQueue() {
  const target = $('readyQueue'); if (!target) return;
  const batches = state.readyBatches;
  if (!batches.length) { target.innerHTML = '<div class="empty">Nothing marked ready yet.</div>'; return; }
  target.innerHTML = batches.map((b) => {
    const rem = readyRemaining(b), status = rem === 0 ? 'FULLY DISPATCHED' : (Number(b.dispatchedBoxes || 0) > 0 ? 'PARTIALLY DISPATCHED' : 'READY');
    return `<div class="list-item"><div><div class="item-title">${esc(batchLabel(b))}</div><div class="item-sub">Ready: ${moneyish(b.readyBoxes)} boxes · Dispatched: ${moneyish(b.dispatchedBoxes || 0)} · Balance: ${moneyish(rem)}<br>${moneyish(b.unitsPerBox)} × ${esc(b.containerName || '')} per box · Balance ${moneyish(rem * num(b.litresPerBox))} L ≈ ${moneyish(rem * num(b.kgPerBox))} kg<br>${esc(b.location) || '—'} · ${formatDateTime(b.createdAt)}</div><div class="ready-actions">${rem > 0 ? `<button class="small-btn" data-edit-ready="${b.id}">Edit Ready Qty</button><button class="small-btn primary-mini" data-dispatch-ready="${b.id}">Dispatch</button>` : ''}</div></div><div><span class="badge ${rem === 0 ? 'done' : (Number(b.dispatchedBoxes || 0) > 0 ? 'review' : 'pending')}">${status}</span></div></div>`;
  }).join('');
  target.querySelectorAll('[data-edit-ready]').forEach((btn) => btn.addEventListener('click', () => editReadyBatch(btn.dataset.editReady)));
  target.querySelectorAll('[data-dispatch-ready]').forEach((btn) => btn.addEventListener('click', () => { setPackTab('OUTWARD'); $('dispatchReadyId').value = btn.dataset.dispatchReady; renderConsumptionPreview(); }));
}
function populateDispatchReady() {
  const active = state.readyBatches.filter((b) => readyRemaining(b) > 0);
  keepValue($('dispatchReadyId'), '<option value="">Select ready batch</option>' + active.map((b) => `<option value="${b.id}">${esc(batchLabel(b))} · ${moneyish(readyRemaining(b))} boxes ready</option>`).join(''));
}
function populateReadySelects() {
  keepValue($('readyMaterial'), '<option value="">Select material</option>' + chemicals().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(''));
  const sel = $('readyContainer');
  keepValue(sel, containers().map((c) => `<option value="${c.id}">${esc(c.name)} × ${moneyish(c.perBox)} per box</option>`).join(''));
  keepValue($('packInItem'), '<option value="">Select item</option>' + packItems().map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join(''));
}
async function editReadyBatch(id) {
  const b = state.readyBatches.find((x) => x.id === id); if (!b) return;
  const min = Number(b.dispatchedBoxes || 0);
  const entered = prompt(`Edit total ready quantity for ${batchLabel(b)}. Minimum ${min} boxes already dispatched.`, String(b.readyBoxes));
  if (entered === null) return;
  const newQty = Number(entered);
  if (!Number.isInteger(newQty) || newQty < min) { showToast(`Ready quantity cannot be below ${min}.`); return; }
  try {
    await runTransaction(db, async (tx) => {
      const r = ref(`readyBatches/${id}`);
      const [bs, ss] = await Promise.all([tx.get(r), tx.get(STOCK())]);
      const cur = bs.data(), stock = ss.data() || {};
      if (newQty < num(cur.dispatchedBoxes)) throw new Error(`Ready quantity cannot be below ${num(cur.dispatchedBoxes)}.`);
      const delta = newQty - num(cur.readyBoxes);
      if (!delta) return;
      const change = scale(cur.packPerBox, delta);
      const short = Object.entries(change).filter(([k, q]) => q > 0 && num(stock[k]) < q).map(([k]) => packName(k));
      if (short.length) throw new Error('Insufficient packaging: ' + short.join(', '));
      tx.set(STOCK(), Object.fromEntries(Object.entries(change).map(([k, q]) => [k, num(stock[k]) - q])), { merge: true });
      tx.update(r, { readyBoxes: newQty, updatedAt: nowISO() });
      tx.set(newRef('packTxns'), { type: 'READY_EDIT', readyId: id, boxes: newQty, deltaBoxes: delta, product: batchLabel(cur), createdAt: nowISO(), by: by() });
    });
    showToast('Ready quantity updated');
  } catch (error) { showToast(error.message); }
}
function renderPackaging() {
  renderPackagingCards($('packStockCards'));
  const totalReady = state.readyBatches.reduce((a, b) => a + readyRemaining(b), 0);
  const totalLitres = state.readyBatches.reduce((a, b) => a + readyRemaining(b) * num(b.litresPerBox), 0);
  const totalKg = state.readyBatches.reduce((a, b) => a + readyRemaining(b) * num(b.kgPerBox), 0);
  $('readyTotalBoxes').textContent = `${moneyish(totalReady)} boxes`;
  $('readyTotalSub').textContent = `${moneyish(totalLitres)} L ≈ ${moneyish(totalKg)} kg · packed finished boxes physically available for dispatch.`;
  renderSoldSummary($('soldSummary'));
  populateReadySelects(); populateDispatchReady(); renderConsumptionPreview(); renderReadyConsumptionPreview(); renderReadyQueue(); renderPackRegister();
}
function renderPackRegister() {
  const target = $('packRegister'); if (!target) return;
  const q = ($('packSearch')?.value || '').toLowerCase().trim();
  const txns = state.txns.filter((t) => !q || JSON.stringify(t).toLowerCase().includes(q));
  if (!txns.length) { target.innerHTML = '<div class="empty">No packaging transactions yet.</div>'; return; }
  target.innerHTML = txns.map((t) => {
    let desc = '';
    if (t.type === 'INWARD') desc = `${esc(packName(t.item))} · +${moneyish(t.qty)}${t.supplier ? ' · ' + esc(t.supplier) : ''}`;
    else if (t.type === 'READY') desc = `${esc(t.product)} · ${moneyish(t.boxes)} boxes packed/ready · ${moneyish(t.litres)} L ≈ ${moneyish(t.kg)} kg`;
    else if (t.type === 'READY_EDIT') desc = `${esc(t.product)} · ready changed by ${t.deltaBoxes >= 0 ? '+' : ''}${moneyish(t.deltaBoxes)} boxes`;
    else if (t.type === 'OUTWARD') desc = `${esc(t.product || 'Finished boxes')} · dispatched ${moneyish(t.boxes)} boxes · ${moneyish(t.litres)} L ≈ ${moneyish(t.kg)} kg${t.vehicleNo ? ' · ' + esc(t.vehicleNo) : ''}`;
    return `<div class="list-item"><div><div class="item-title">${t.type} · ${esc(t.invoiceNo) || '—'}</div><div class="item-sub">${desc}<br>${formatDateTime(t.createdAt)}${t.by ? ' · ' + esc(t.by) : ''}</div></div><div><span class="badge ${t.type === 'INWARD' ? 'done' : (t.type === 'OUTWARD' ? 'review' : 'pending')}">${t.type}</span></div></div>`;
  }).join('');
}
function setPackTab(tab) {
  document.querySelectorAll('[data-pack-tab]').forEach((b) => b.classList.toggle('active', b.dataset.packTab === tab));
  $('packReadyPanel').classList.toggle('hidden', tab !== 'READY');
  $('packOutwardPanel').classList.toggle('hidden', tab !== 'OUTWARD');
  $('packInwardPanel').classList.toggle('hidden', tab !== 'INWARD');
  $('packRegisterPanel').classList.toggle('hidden', tab !== 'REGISTER');
}
document.querySelectorAll('[data-pack-tab]').forEach((b) => b.addEventListener('click', () => setPackTab(b.dataset.packTab)));
$('packOutBoxes').addEventListener('input', renderConsumptionPreview);
$('dispatchReadyId').addEventListener('change', renderConsumptionPreview);
$('readyBoxes').addEventListener('input', renderReadyConsumptionPreview);
$('readyMaterial').addEventListener('change', renderReadyConsumptionPreview);
$('readyContainer').addEventListener('change', renderReadyConsumptionPreview);
$('packSearch').addEventListener('input', renderPackRegister);

async function addPackagingInward({ itemKey, qty, invoiceNo, supplier, vehicleNo = '', location = '' }) {
  if (!itemKey || !(qty > 0) || !Number.isInteger(qty)) throw new Error('Enter item and a whole-number quantity.');
  await runTransaction(db, async (tx) => {
    const s = await tx.get(STOCK());
    const stock = s.data() || {};
    tx.set(STOCK(), { [itemKey]: num(stock[itemKey]) + qty }, { merge: true });
    tx.set(newRef('packTxns'), { type: 'INWARD', invoiceNo: invoiceNo || '', item: itemKey, qty, supplier: supplier || '', vehicleNo, location, createdAt: nowISO(), by: by() });
  });
}
$('packInwardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addPackagingInward({ itemKey: $('packInItem').value, qty: Number($('packInQty').value || 0), invoiceNo: $('packInInvoice').value.trim(), supplier: $('packInSupplier').value.trim() });
    e.target.reset();
    showToast('Packaging stock added');
  } catch (error) { showToast(error.message); }
});
$('packReadyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const boxes = Number($('readyBoxes').value || 0);
  if (!(boxes > 0) || !Number.isInteger(boxes)) { showToast('Enter boxes ready.'); return; }
  const product = state.products.find((p) => p.id === $('readyMaterial').value);
  const container = state.packMaterials.find((m) => m.id === $('readyContainer').value);
  if (!product) { showToast('Select the material in the box.'); return; }
  if (!container) { showToast('Add a container (bottle/can) in Masters first.'); return; }
  const packPerBox = perBoxConsumption(container);
  const need = scale(packPerBox, boxes);
  const fill = fillPerBox(container, product.density);
  const batchNo = $('readyBatchNo').value.trim();
  try {
    await runTransaction(db, async (tx) => {
      const s = await tx.get(STOCK());
      const stock = s.data() || {};
      const short = Object.entries(need).filter(([k, q]) => num(stock[k]) < q).map(([k, q]) => `${packName(k)} (need ${q}, have ${num(stock[k])})`);
      if (short.length) throw new Error('Insufficient packaging: ' + short.join(', '));
      tx.set(STOCK(), Object.fromEntries(Object.entries(need).map(([k, q]) => [k, num(stock[k]) - q])), { merge: true });
      const r = newRef('readyBatches');
      const b = {
        product: `${product.name}${batchNo ? ' / Batch ' + batchNo : ''}`, productId: product.id, productName: product.name, batchNo, density: num(product.density),
        containerId: container.id, containerName: container.name, unitsPerBox: num(container.perBox), litresPerBox: fill.litres, kgPerBox: fill.kg,
        readyBoxes: boxes, dispatchedBoxes: 0, packPerBox, location: $('readyLocation').value.trim(), remarks: $('readyRemarks').value.trim(), createdAt: nowISO(), by: by(),
      };
      tx.set(r, b);
      tx.set(newRef('packTxns'), { type: 'READY', readyId: r.id, product: b.product, boxes, litres: fill.litres * boxes, kg: fill.kg * boxes, consumption: need, createdAt: nowISO(), by: by() });
    });
    $('readyBatchNo').value = ''; $('readyBoxes').value = ''; $('readyRemarks').value = '';
    renderReadyConsumptionPreview();
    showToast(`${boxes} boxes of ${product.name} marked ready`);
  } catch (error) { showToast(error.message); }
});
$('packOutwardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('dispatchReadyId').value;
  if (!id) { showToast('Select ready batch.'); return; }
  const boxes = Number($('packOutBoxes').value || 0);
  if (!(boxes > 0) || !Number.isInteger(boxes)) { showToast('Enter dispatch quantity.'); return; }
  const invoiceNo = $('packOutInvoice').value.trim();
  try {
    const left = await runTransaction(db, async (tx) => {
      const r = ref(`readyBatches/${id}`);
      const [bs, ts] = await Promise.all([tx.get(r), tx.get(TOTALS())]);
      if (!bs.exists()) throw new Error('Ready batch not found.');
      const b = bs.data();
      const remain = readyRemaining(b);
      if (boxes > remain) throw new Error(`Only ${remain} boxes are ready in this batch.`);
      const litres = boxes * num(b.litresPerBox), kg = boxes * num(b.kgPerBox);
      const t = ts.data() || {};
      const byProduct = { ...(t.byProduct || {}) };
      const p = byProduct[b.productId] || { name: b.productName, boxes: 0, litres: 0, kg: 0 };
      byProduct[b.productId] = { name: b.productName, boxes: num(p.boxes) + boxes, litres: num(p.litres) + litres, kg: num(p.kg) + kg };
      tx.set(TOTALS(), { boxes: num(t.boxes) + boxes, litres: num(t.litres) + litres, kg: num(t.kg) + kg, byProduct });
      tx.update(r, { dispatchedBoxes: num(b.dispatchedBoxes) + boxes, updatedAt: nowISO() });
      tx.set(newRef('packTxns'), {
        type: 'OUTWARD', invoiceNo, readyId: id, product: batchLabel(b), productId: b.productId, productName: b.productName, boxes, units: boxes * num(b.unitsPerBox), litres, kg,
        vehicleNo: $('packOutVehicle').value.trim().toUpperCase(), from: $('packOutFrom').value.trim(), to: $('packOutTo').value.trim(), createdAt: nowISO(), by: by(),
      });
      return { left: remain - boxes, litres, kg };
    });
    e.target.reset();
    renderConsumptionPreview();
    showToast(`${boxes} boxes dispatched · ${moneyish(left.litres)} L ≈ ${moneyish(left.kg)} kg · ${left.left} remaining`);
  } catch (error) { showToast(error.message); }
});

/* ------------------------------------------------------------------ Masters (new) */
async function addSupplier(name, info) {
  if (state.suppliers.some((s) => s.name.toLowerCase() === name.toLowerCase())) { showToast(`${name} already exists.`); return false; }
  try {
    await setDoc(newRef('suppliers'), { name, info: info || '', active: true, createdAt: nowISO(), by: by() });
    showToast(`Supplier ${name} added`);
    return true;
  } catch (error) { showToast(error.message); return false; }
}
async function addProduct(name, density) {
  const d = Number(density);
  if (!(d > 0 && d < 3)) { showToast('Enter density in kg/L, e.g. 0.792'); return null; }
  if (state.products.some((p) => p.name.toLowerCase() === name.toLowerCase())) { showToast(`${name} already exists.`); return null; }
  try {
    const r = newRef('products');
    await setDoc(r, { name, density: d, active: true, createdAt: nowISO(), by: by() });
    showToast(`Product ${name} added`);
    return r.id;
  } catch (error) { showToast(error.message); return null; }
}
function setMasterTab(tab) {
  document.querySelectorAll('[data-master-tab]').forEach((b) => b.classList.toggle('active', b.dataset.masterTab === tab));
  $('mSupPanel').classList.toggle('hidden', tab !== 'SUP');
  $('mProdPanel').classList.toggle('hidden', tab !== 'PROD');
  $('mPackPanel').classList.toggle('hidden', tab !== 'PACK');
}
document.querySelectorAll('[data-master-tab]').forEach((b) => b.addEventListener('click', () => setMasterTab(b.dataset.masterTab)));

function renderMasters() {
  $('supplierList').innerHTML = state.suppliers.length ? state.suppliers.map((s) => `<div class="list-item"><div><div class="item-title">${esc(s.name)}</div><div class="item-sub">${esc(s.info) || 'Supplier'}</div></div><div></div></div>`).join('') : '<div class="empty">No suppliers yet.</div>';
  $('productList').innerHTML = state.products.map((p) => `<div class="list-item"><div><div class="item-title">${esc(p.name)}</div><div class="item-sub">Density ${moneyish(p.density)} kg/L · 1 box of 10 L ≈ ${moneyish(10 * num(p.density))} kg</div></div><div><button class="small-btn" data-density="${p.id}">Edit Density</button></div></div>`).join('');
  $('productList').querySelectorAll('[data-density]').forEach((b) => b.addEventListener('click', async () => {
    const p = state.products.find((x) => x.id === b.dataset.density);
    const v = prompt(`Density of ${p.name} (kg/L)`, String(p.density));
    if (v === null) return;
    if (!(Number(v) > 0 && Number(v) < 3)) { showToast('Enter density in kg/L, e.g. 0.792'); return; }
    try { await setDoc(ref(`products/${p.id}`), { density: Number(v), updatedAt: nowISO(), by: by() }, { merge: true }); showToast('Density updated'); } catch (error) { showToast(error.message); }
  }));
  $('packMatList').innerHTML = packItems().map((m) => {
    const fill = fillPerBox(m, 1);
    const detail = m.role === 'container'
      ? `Capacity ${moneyish(m.capacity)} ${m.unit === 'kg' ? 'kg' : 'L'} each · ${moneyish(m.perBox)} per box = ${moneyish(m.unit === 'kg' ? fill.kg : fill.litres)} ${m.unit === 'kg' ? 'kg' : 'L'} per box`
      : `${moneyish(m.perBox)} used per box`;
    return `<div class="list-item"><div><div class="item-title">${esc(m.name)}<span class="tag">${m.role === 'container' ? 'CONTAINER' : 'ACCESSORY'}</span></div><div class="item-sub">${detail}<br>Stock ${moneyish(state.stock[m.id])} Nos. · low alert below ${moneyish(m.lowAlert ?? 50)}</div></div><div><button class="small-btn" data-edit-pack="${m.id}">Edit</button></div></div>`;
  }).join('') || '<div class="empty">No packaging materials yet.</div>';
  $('packMatList').querySelectorAll('[data-edit-pack]').forEach((b) => b.addEventListener('click', () => startPackEdit(b.dataset.editPack)));
  updatePackMatForm();
}
function updatePackMatForm() {
  const isContainer = $('pmRole').value === 'container';
  $('pmCapWrap').classList.toggle('hidden', !isContainer);
  $('pmUnitWrap').classList.toggle('hidden', !isContainer);
  $('pmCapacity').required = isContainer;
  $('pmPerBoxLabel').textContent = isContainer ? 'Pieces per Box' : 'Qty used per Box';
  const cap = num($('pmCapacity').value), per = num($('pmPerBox').value), unit = $('pmUnit').value;
  $('pmPreview').innerHTML = isContainer
    ? `<div><span>One box holds</span><strong>${moneyish(cap * per)} ${unit === 'kg' ? 'kg' : 'L'}</strong></div><small>${moneyish(per)} pieces × ${moneyish(cap)} ${unit === 'kg' ? 'kg' : 'L'} each. Kg/litres for each material are converted with its density.</small>`
    : `<div><span>Deducted per box</span><strong>${moneyish(per)} Nos.</strong></div><small>Deducted automatically for every box marked ready.</small>`;
}
['pmRole', 'pmCapacity', 'pmPerBox', 'pmUnit'].forEach((id) => $(id).addEventListener('input', updatePackMatForm));
$('pmRole').addEventListener('change', updatePackMatForm);
function startPackEdit(id) {
  const m = state.packMaterials.find((x) => x.id === id); if (!m) return;
  editingPackId = id;
  $('pmName').value = m.name; $('pmRole').value = m.role; $('pmCapacity').value = m.capacity || ''; $('pmUnit').value = m.unit || 'L';
  $('pmPerBox').value = m.perBox ?? ''; $('pmLow').value = m.lowAlert ?? 50;
  $('packMatTitle').textContent = `Edit ${m.name}`; $('pmSubmit').textContent = 'Update Packaging Material'; $('pmCancel').classList.remove('hidden');
  updatePackMatForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function resetPackForm() {
  editingPackId = null; $('packMatForm').reset(); $('pmLow').value = 50;
  $('packMatTitle').textContent = 'Add New Packaging Material'; $('pmSubmit').textContent = 'Add Packaging Material'; $('pmCancel').classList.add('hidden');
  updatePackMatForm();
}
$('pmCancel').addEventListener('click', resetPackForm);
$('packMatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('pmName').value.trim();
  const role = $('pmRole').value;
  const data = { name, role, capacity: role === 'container' ? num($('pmCapacity').value) : 0, unit: $('pmUnit').value, perBox: num($('pmPerBox').value), lowAlert: num($('pmLow').value) };
  if (role === 'container' && !(data.capacity > 0 && data.perBox > 0)) { showToast('Enter capacity and pieces per box.'); return; }
  if (!editingPackId && state.packMaterials.some((m) => m.name.toLowerCase() === name.toLowerCase())) { showToast(`${name} already exists.`); return; }
  try {
    if (editingPackId) await setDoc(ref(`packMaterials/${editingPackId}`), { ...data, updatedAt: nowISO(), by: by() }, { merge: true });
    else await setDoc(newRef('packMaterials'), { ...data, active: true, order: 50, createdAt: nowISO(), by: by() });
    showToast(editingPackId ? `${name} updated` : `${name} added`);
    resetPackForm();
  } catch (error) { showToast(error.message); }
});
$('supplierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await addSupplier($('supName').value.trim(), $('supInfo').value.trim())) e.target.reset();
});
$('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await addProduct($('prodName').value.trim(), $('prodDensity').value)) e.target.reset();
});

/* ------------------------------------------------------------------ Reset (admin only — replaces V5 "reset demo data") */
$('resetDemoBtn').addEventListener('click', async () => {
  if (!isAdmin) return;
  const typed = prompt('This clears ALL inwards, packaging stock, ready batches, dispatches and register entries for everyone.\nSuppliers, products and packaging materials are kept.\n\nType RESET to confirm.');
  if (typed !== 'RESET') return;
  try {
    for (const name of ['inwards', 'readyBatches', 'packTxns']) {
      const snap = await getDocs(col(name));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
    await setDoc(STOCK(), {});
    await setDoc(TOTALS(), { boxes: 0, litres: 0, kg: 0, byProduct: {} });
    await setDoc(COUNTERS(), { seeded: true, inward: 0, grn: 0 });
    showToast('All operational data cleared');
  } catch (error) { showToast(error.message); }
});

/* ------------------------------------------------------------------ Live data */
function rerender() {
  initSelects();
  if (currentView === 'dashboardView') renderDashboard();
  if (currentView === 'inwardsView') renderInwards();
  if (currentView === 'packagingView') renderPackaging();
  if (currentView === 'mastersView') renderMasters();
  if (currentView === 'detailView' && selectedInwardId) {
    const i = state.inwards.find((x) => x.id === selectedInwardId);
    if (i && `${i.id}:${statusOf(i)}` !== renderedDetailKey) openDetail(i.id);
  }
}
let rerenderQueued = false;
function queueRerender() { if (rerenderQueued) return; rerenderQueued = true; setTimeout(() => { rerenderQueued = false; rerender(); }, 0); }

function subscribe() {
  const put = (key) => (v) => { state[key] = v; queueRerender(); };
  const listOf = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  unsubs.push(onSnapshot(col('suppliers'), (s) => put('suppliers')(listOf(s).sort(byName))));
  unsubs.push(onSnapshot(col('products'), (s) => put('products')(listOf(s).sort(byName))));
  unsubs.push(onSnapshot(col('packMaterials'), (s) => put('packMaterials')(listOf(s))));
  unsubs.push(onSnapshot(STOCK(), (s) => put('stock')(s.data() || {})));
  unsubs.push(onSnapshot(TOTALS(), (s) => put('totals')(s.data() || {})));
  unsubs.push(onSnapshot(query(col('inwards'), orderBy('createdAt', 'desc'), limit(500)), (s) => put('inwards')(listOf(s))));
  unsubs.push(onSnapshot(query(col('readyBatches'), orderBy('createdAt', 'desc'), limit(300)), (s) => put('readyBatches')(listOf(s))));
  unsubs.push(onSnapshot(query(col('packTxns'), orderBy('createdAt', 'desc'), limit(500)), (s) => put('txns')(listOf(s))));
}

/** First run on a Firebase project: create default masters (and carry over v1 packaging stock if present). */
async function ensureSeed() {
  const c = await getDoc(COUNTERS());
  if (c.exists() && c.data().seeded) return;
  await runTransaction(db, async (tx) => {
    const [cs, legacy, st] = await Promise.all([tx.get(COUNTERS()), tx.get(ref('stock/current')), tx.get(STOCK())]);
    if (cs.exists() && cs.data().seeded) return;
    const o = legacy.exists() ? legacy.data() : {};
    const s = st.data() || {};
    DEFAULT_SUPPLIERS.forEach((name, i) => tx.set(ref(`suppliers/SUP${i + 1}`), { name, info: '', active: true, createdAt: nowISO(), by: by() }));
    DEFAULT_PRODUCTS.forEach(({ id, ...p }) => tx.set(ref(`products/${id}`), { ...p, active: true, createdAt: nowISO(), by: by() }));
    DEFAULT_PACK.forEach(({ id, ...p }) => tx.set(ref(`packMaterials/${id}`), { ...p, active: true, createdAt: nowISO(), by: by() }));
    tx.set(STOCK(), {
      BOTTLE_2_5L: num(s.BOTTLE_2_5L) + num(o.emptyBottles), EMPTY_BOX: num(s.EMPTY_BOX) + num(o.emptyBoxes),
      BOX_PLATE: num(s.BOX_PLATE) + num(o.boxPlates), THERMOCOL: num(s.THERMOCOL) + num(o.thermocol),
    }, { merge: true });
    tx.set(COUNTERS(), { seeded: true, inward: num(cs.data()?.inward), grn: num(cs.data()?.grn) }, { merge: true });
  });
}

/* ------------------------------------------------------------------ Sign-in (Firebase Auth — approved emails only) */
let authMode = 'login';
function authMsg(text, ok = false) { const el = $('authMsg'); el.textContent = text; el.classList.toggle('hidden', !text); el.classList.toggle('ok', ok); }
function setDbStatus(text, color) { const el = $('dbStatus'); el.textContent = text; el.style.color = color || ''; }
$('authToggle').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'reset' : 'login';
  $('authTitle').textContent = authMode === 'login' ? 'Sign in' : 'Reset password';
  $('authPassWrap').classList.toggle('hidden', authMode !== 'login');
  $('authSubmit').textContent = authMode === 'login' ? 'Sign In' : 'Send Reset Link';
  $('authToggle').textContent = authMode === 'login' ? 'Forgot password?' : 'Back to sign in';
  authMsg('');
});
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) { authMsg('Firebase is not configured. Add the VITE_FIREBASE_* values to .env.local / Vercel.'); return; }
  const email = $('authEmail').value.trim().toLowerCase();
  if (!ALLOWED_EMAILS.includes(email)) { authMsg('This email address is not on the approved CCPL access list.'); return; }
  $('authSubmit').disabled = true;
  try {
    if (authMode === 'reset') { await sendPasswordResetEmail(auth, email); authMsg('Password reset link sent. Check your inbox.', true); }
    else await signInWithEmailAndPassword(auth, email, $('authPass').value);
  } catch (error) { authMsg(error.code === 'auth/invalid-credential' ? 'Wrong email or password.' : (error.message || 'Sign-in failed.')); }
  $('authSubmit').disabled = false;
});
$('authResend').addEventListener('click', async () => {
  if (!auth.currentUser) return;
  try { await sendEmailVerification(auth.currentUser); authMsg('Verification email sent. Verify, then sign in again.', true); } catch (error) { authMsg(error.message); }
});
$('signOutBtn').addEventListener('click', () => { if (confirm('Sign out?')) signOut(auth); });

async function startSession(user) {
  const profileRef = doc(db, `${ROOT}/users`, user.uid);
  let profile = await getDoc(profileRef);
  if (!profile.exists()) {
    await setDoc(profileRef, { email: user.email, name: user.displayName || user.email, role: user.email.toLowerCase() === ADMIN_EMAIL ? 'admin' : 'staff', active: true, createdAt: serverTimestamp() });
    profile = await getDoc(profileRef);
  }
  if (!profile.data()?.active) throw new Error('This account is disabled. Contact the CCPL administrator.');
  await ensureSeed();
  subscribe();
}

initSelects();
updateProductMode();
renderDashboard();
renderPackaging();

if (!firebaseReady) {
  setDbStatus('Database: Firebase not configured', '#fca5a5');
  authMsg('Firebase is not configured. Add the VITE_FIREBASE_* values to .env.local / Vercel.');
} else {
  onAuthStateChanged(auth, async (user) => {
    unsubs.forEach((fn) => fn()); unsubs = [];
    currentUser = null; isAdmin = false;
    $('resetDemoBtn').classList.add('hidden');
    $('authResend').classList.add('hidden');
    if (!user) { $('authScreen').classList.remove('hidden'); setDbStatus('Database: signed out'); return; }
    if (!ALLOWED_EMAILS.includes((user.email || '').toLowerCase())) { await signOut(auth); authMsg('This email address is not approved for the CCPL app.'); return; }
    if (!user.emailVerified) {
      await reload(user).catch(() => {});
      if (!auth.currentUser?.emailVerified) {
        $('authScreen').classList.remove('hidden');
        $('authResend').classList.remove('hidden');
        authMsg('Please verify your email first (check your inbox), then sign in again.');
        return;
      }
    }
    currentUser = user;
    isAdmin = user.email.toLowerCase() === ADMIN_EMAIL;
    $('resetDemoBtn').classList.toggle('hidden', !isAdmin);
    $('authScreen').classList.add('hidden');
    setDbStatus('Database: connecting...');
    try {
      await startSession(user);
      setDbStatus(`Database: connected · ${user.email}`, '#86efac');
    } catch (error) {
      console.error(error);
      setDbStatus('Database: connection failed', '#fca5a5');
      $('dbStatus').title = error.message;
      showToast(error.message);
    }
  });
}
