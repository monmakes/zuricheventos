'use strict';

console.info('Zurich Eventos build ISSUE-006-PAYMENT-RECOVERY');

// Zurich Eventos V1 hardening notes:
// This remains a static prototype. Frontend controls improve safety for demo/testing,
// but production reservations, Stripe, accounts, admin, and inventory must be enforced server-side.
const CONFIG = Object.freeze({
  capacity: Object.freeze({ chairs: 100, tables: 10, auxTables: 1, linens: 10 }),
  prices: Object.freeze({ chairUnit: 150, chairPackage: 100, tableUnit: 600, tablePackage: 500, auxTable: 500 }),
  reservationEndpoint: 'https://nyuycifpmojxvnbjsgnr.supabase.co/functions/v1/create-reservation',
  checkoutEndpoint: 'https://nyuycifpmojxvnbjsgnr.supabase.co/functions/v1/create-checkout-session',
  coverage: Object.freeze(['Polanco', 'Anzures']),
  whatsapp: '525583745123',
  sameDayCode: 'ZURICH-HOY', // Demo only. Move same-day approvals to backend before production.
  pickupHours: Object.freeze([9, 10, 11, 12, 13]),
  maxNotesLength: 500,
  maxLocalBookings: 200,
  rateLimit: Object.freeze({ key: 'zurichBookingAttempts', max: 5, windowMs: 10 * 60 * 1000 }),
  adminSessionKey: 'zurichAdminUnlocked',
  adminUnlockPhrase: 'ENTIENDO QUE ES DEMO',
  piiNotice: 'Los datos de la reservación se procesan en el servidor de Zurich Eventos.',
  activeReservationKey: 'zurichActiveReservation'
});

let activePackage = '10';
let embeddedCheckout = null;
let activeReservation = null;
let holdCountdownTimer = null;
let holdExpirationInProgress = false;

const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n) || 0);
const dateFmt = (v) => v ? new Date(`${v}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Por definir';
const timeLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const todayISO = () => new Date().toISOString().slice(0, 10);

function normalizeText(value, max = 180) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return normalizeText(value, 254).toLowerCase();
}

function normalizePhone(value) {
  return normalizeText(value, 20).replace(/[^0-9+()\s.-]/g, '').slice(0, 20);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value) && value.length <= 254;
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clampInt(value, min, max, step = 1) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  const clamped = Math.min(Math.max(n, min), max);
  return Math.round(clamped / step) * step;
}

function maskEmail(email) {
  const value = normalizeEmail(email);
  const [local, domain] = value.split('@');
  if (!local || !domain) return '';
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskName(name) {
  const value = normalizeText(name, 120);
  if (!value) return '';
  const parts = value.split(' ');
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : `${value[0]}***`;
}

function sanitizeStoredBooking(booking) {
  const eventDate = isValidDateString(booking?.eventDate) ? booking.eventDate : '';
  const chairs = clampInt(booking?.chairs, 0, CONFIG.capacity.chairs, 1);
  const tables = clampInt(booking?.tables, 0, CONFIG.capacity.tables, 1);
  const auxTables = clampInt(booking?.auxTables, 0, CONFIG.capacity.auxTables, 1);
  const isPackage = booking?.pricingMode === 'package';
  const rental = chairs * (isPackage ? CONFIG.prices.chairPackage : CONFIG.prices.chairUnit)
    + tables * (isPackage ? CONFIG.prices.tablePackage : CONFIG.prices.tableUnit)
    + auxTables * CONFIG.prices.auxTable;
  return {
    id: normalizeText(booking?.id, 40),
    eventDate,
    deliveryTime: normalizeText(booking?.deliveryTime, 10),
    pickupDate: isValidDateString(booking?.pickupDate) ? booking.pickupDate : addDays(eventDate, 1),
    pickupTime: normalizeText(booking?.pickupTime, 10),
    chairs,
    tables,
    auxTables,
    pricingMode: isPackage ? 'package' : 'unit',
    linens: Math.min(tables, CONFIG.capacity.linens),
    rental,
    deposit: Math.round(rental * 0.15),
    customer: normalizeText(booking?.customer, 80),
    email: normalizeText(booking?.email, 254),
    status: normalizeText(booking?.status, 40) || 'confirmed_mock',
    createdAt: normalizeText(booking?.createdAt, 40)
  };
}

function getBookings() {
  try {
    const parsed = JSON.parse(localStorage.getItem('zurichBookings') || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, CONFIG.maxLocalBookings).map(sanitizeStoredBooking) : [];
  } catch (error) {
    console.warn('No se pudieron leer las reservas locales de demo.');
    return [];
  }
}

function setBookings(bookings) {
  const safeBookings = Array.isArray(bookings) ? bookings.slice(0, CONFIG.maxLocalBookings).map(sanitizeStoredBooking) : [];
  localStorage.setItem('zurichBookings', JSON.stringify(safeBookings));
}



function saveActiveReservation(reservation, customerEmail) {
  const record = {
    reservation_id: normalizeText(reservation?.reservation_id, 80),
    reservation_number: normalizeText(reservation?.reservation_number, 40),
    customer_email: normalizeEmail(customerEmail),
    total_amount: Number(reservation?.total_amount) || 0,
    hold_expires_at: normalizeText(reservation?.hold_expires_at, 50),
    session_id: normalizeText(reservation?.session_id, 120)
  };

  if (!record.reservation_id || !record.reservation_number || !record.customer_email) return;
  localStorage.setItem(CONFIG.activeReservationKey, JSON.stringify(record));
}

function readActiveReservation() {
  try {
    const record = JSON.parse(localStorage.getItem(CONFIG.activeReservationKey) || 'null');
    if (!record) return null;
    return {
      reservation_id: normalizeText(record.reservation_id, 80),
      reservation_number: normalizeText(record.reservation_number, 40),
      customer_email: normalizeEmail(record.customer_email),
      total_amount: Number(record.total_amount) || 0,
      hold_expires_at: normalizeText(record.hold_expires_at, 50),
      session_id: normalizeText(record.session_id, 120)
    };
  } catch {
    return null;
  }
}

function stopHoldCountdown() {
  if (holdCountdownTimer) {
    window.clearInterval(holdCountdownTimer);
    holdCountdownTimer = null;
  }
}

function clearActiveReservation() {
  stopHoldCountdown();
  localStorage.removeItem(CONFIG.activeReservationKey);
  activeReservation = null;
}

function addDays(dateStr, days) {
  if (!isValidDateString(dateStr)) return '';
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function deliveryHours(dateStr) {
  if (!isValidDateString(dateStr)) return [];
  const day = new Date(`${dateStr}T12:00:00`).getDay();
  if (day === 5) return [12, 13, 14, 15, 16];
  if (day === 6 || day === 0) return [10, 11, 12, 13, 14, 15, 16];
  return [];
}

function isSameDay(dateStr) {
  return dateStr === todayISO();
}

function reservedOn(dateStr) {
  const bookings = getBookings().filter((b) => b.eventDate === dateStr || b.pickupDate === dateStr);
  return bookings.reduce((acc, b) => {
    acc.chairs += clampInt(b.chairs, 0, CONFIG.capacity.chairs, 1);
    acc.tables += clampInt(b.tables, 0, CONFIG.capacity.tables, 1);
    acc.auxTables += clampInt(b.auxTables, 0, CONFIG.capacity.auxTables, 1);
    return acc;
  }, { chairs: 0, tables: 0, auxTables: 0 });
}

function availableFor(dateStr) {
  const r = reservedOn(dateStr);
  return {
    chairs: Math.max(0, CONFIG.capacity.chairs - r.chairs),
    tables: Math.max(0, CONFIG.capacity.tables - r.tables),
    auxTables: Math.max(0, CONFIG.capacity.auxTables - r.auxTables)
  };
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  const allowedAttrs = new Set(['aria-label', 'class', 'colspan', 'id', 'role', 'scope', 'title', 'type']);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (allowedAttrs.has(key)) node.setAttribute(key, String(value));
  });
  children.forEach((child) => node.append(child));
  return node;
}

function setStatus(message) {
  $('availabilityStatus').textContent = message;
}

function updateTimeOptions() {
  const date = $('formEventDate').value;
  const delivery = $('deliveryTime');
  clearChildren(delivery);
  const hours = deliveryHours(date);
  if (!hours.length) {
    delivery.add(new Option('Disponible viernes, sábado y domingo', ''));
  } else {
    hours.forEach((h) => delivery.add(new Option(timeLabel(h), timeLabel(h))));
  }

  const pickup = $('pickupTime');
  clearChildren(pickup);
  const pickupDate = addDays(date || todayISO(), 1);
  CONFIG.pickupHours.forEach((h) => pickup.add(new Option(`${dateFmt(pickupDate)} · ${timeLabel(h)}`, timeLabel(h))));
  $('sameDayWrap').classList.toggle('hidden', !isSameDay(date));
}

function appendSummaryLine(parent, label, value) {
  const row = el('div', { class: 'summary-line' }, [el('span', { text: label }), el('strong', { text: value })]);
  parent.append(row);
}

function calc() {
  const chairs = clampInt($('chairsQty').value, 0, CONFIG.capacity.chairs, 1);
  const tables = clampInt($('tablesQty').value, 0, CONFIG.capacity.tables, 1);
  const auxTables = clampInt($('auxTablesQty').value, 0, CONFIG.capacity.auxTables, 1);
  $('chairsQty').value = chairs;
  $('tablesQty').value = tables;
  $('auxTablesQty').value = auxTables;

  const packageMatches = (activePackage === '10' && chairs === 10 && tables === 1)
    || (activePackage === '100' && chairs === 100 && tables === 10);
  const pricingMode = packageMatches ? 'package' : 'unit';
  const chairPrice = pricingMode === 'package' ? CONFIG.prices.chairPackage : CONFIG.prices.chairUnit;
  const tablePrice = pricingMode === 'package' ? CONFIG.prices.tablePackage : CONFIG.prices.tableUnit;
  const linens = tables;
  const rental = chairs * chairPrice + tables * tablePrice + auxTables * CONFIG.prices.auxTable;
  const deposit = Math.round(rental * 0.15);

  $('summaryTitle').textContent = pricingMode === 'package'
    ? (activePackage === '100' ? 'Evento completo' : 'Paquete 10 personas')
    : 'Evento personalizado';
  const summary = $('summaryLines');
  clearChildren(summary);
  appendSummaryLine(summary, 'Fecha', dateFmt($('formEventDate').value));
  appendSummaryLine(summary, 'Entrega', $('deliveryTime').value || 'Por elegir');
  appendSummaryLine(summary, 'Recolección', $('pickupTime').value || 'Por elegir');
  appendSummaryLine(summary, 'Sillas', `${chairs} × ${money(chairPrice)}`);
  appendSummaryLine(summary, 'Mesas rectangulares', `${tables} × ${money(tablePrice)}`);
  if (auxTables > 0) appendSummaryLine(summary, 'Mesas auxiliares', `${auxTables} × ${money(CONFIG.prices.auxTable)}`);
  appendSummaryLine(summary, 'Molletón y mantel', `${linens} incluido${linens === 1 ? '' : 's'}`);
  $('rentalTotal').textContent = money(rental);
  $('depositTotal').textContent = money(deposit);
  $('whatsappLink').href = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent('Hola Zurich, tengo una duda sobre una reservación.')}`;
  return { chairs, tables, auxTables, linens, rental, deposit, pricingMode };
}

function applyPackage(type) {
  activePackage = type;
  if (type === '10') { $('chairsQty').value = 10; $('tablesQty').value = 1; }
  else if (type === '100') { $('chairsQty').value = 100; $('tablesQty').value = 10; }
  else { $('chairsQty').value = 0; $('tablesQty').value = 0; }
  document.querySelectorAll('.choice').forEach((b) => b.classList.toggle('active', b.dataset.package === type));
  calc();
}

function appendParagraph(parent, text) { parent.append(el('p', { text })); }
function appendHeading(parent, level, text) { parent.append(el(`h${level}`, { text })); }

function renderContract(data) {
  const root = $('contractPreview');
  clearChildren(root);
  appendHeading(root, 2, 'CONTRATO DE RENTA DE MOBILIARIO PARA EVENTOS');
  const intro = el('p');
  intro.append('Contrato mercantil de prestación de servicios de arrendamiento de mobiliario y acuerdo de uso que celebran, por una parte, ');
  intro.append(el('strong', { text: 'Zurich Eventos' }));
  intro.append(', y por la otra parte ');
  intro.append(el('strong', { text: data.name || 'NOMBRE DEL CLIENTE' }));
  intro.append('.');
  root.append(intro);

  root.append(el('div', { class: 'contract-box' }, [
    el('strong', { text: 'Número de reservación:' }), ` ${data.id || 'ZE-PREVIEW'}`, el('br'),
    el('strong', { text: 'Cliente:' }), ` ${data.name || 'Por definir'}`, el('br'),
    el('strong', { text: 'Teléfono:' }), ` ${data.phone || 'Por definir'}`, el('br'),
    el('strong', { text: 'Correo:' }), ` ${data.email || 'Por definir'}`, el('br'),
    el('strong', { text: 'Domicilio del evento:' }), ` ${data.address || 'Por definir'}, ${data.neighborhood || ''}`
  ]));

  appendHeading(root, 3, 'Objeto');
  appendParagraph(root, 'Zurich Eventos se obliga a proporcionar en calidad de renta el mobiliario descrito en esta reservación y en el Anexo A. El cliente se compromete a pagar el monto acordado y devolver el mobiliario en las condiciones establecidas.');
  appendHeading(root, 3, 'Precio y vigencia');
  root.append(el('div', { class: 'contract-box' }, [
    el('strong', { text: 'Fecha del evento:' }), ` ${dateFmt(data.eventDate)}`, el('br'),
    el('strong', { text: 'Entrega:' }), ` ${data.deliveryTime || 'Por definir'}`, el('br'),
    el('strong', { text: 'Recolección:' }), ` ${dateFmt(data.pickupDate)} · ${data.pickupTime || 'Por definir'}`, el('br'),
    el('strong', { text: 'Importe de renta:' }), ` ${money(data.rental)} IVA incluido`, el('br'),
    el('strong', { text: 'Depósito en garantía:' }), ` ${money(data.deposit)} equivalente al 15% del total de renta. No forma parte del checkout y se entrega el día del montaje.`
  ]));
  appendHeading(root, 3, 'Anexo A · Mobiliario arrendado');
  root.append(el('div', { class: 'contract-box' }, [
    `${data.tables || 0} Mesa(s) rectangular(es) para 10 personas`, el('br'),
    `${data.auxTables || 0} Mesa(s) auxiliar(es) de 4 pies`, el('br'),
    `${data.chairs || 0} Silla(s) Avant Garde`, el('br'),
    `${data.linens || 0} Molletón(es) y mantel(es) blanco(s) incluido(s)`
  ]));
  appendHeading(root, 3, 'Depósito en garantía');
  appendParagraph(root, 'El depósito en garantía se entrega el día del montaje en efectivo, por transferencia o con tarjeta. No se cobra dentro del checkout. Responde por daños, pérdida, robo, destrucción o faltantes del mobiliario rentado y se devuelve al finalizar el servicio si todo el mobiliario está completo y en buen estado.');
  appendHeading(root, 3, 'Aceptación electrónica');
  appendParagraph(root, 'Al realizar la reservación y efectuar el pago a través del sitio web, el cliente manifiesta haber leído, comprendido y aceptado el contrato, los términos y condiciones y el aviso de privacidad.');
  const note = el('p');
  note.append(el('em', { text: 'Preview generado automáticamente para pruebas de V1. La versión final de producción debe validarse legalmente antes de activarse con pagos reales.' }));
  root.append(note);
}

function collectData(preview = false) {
  const totals = calc();
  const eventDate = $('formEventDate').value;
  return {
    id: 'ZE-PREVIEW',
    eventDate,
    deliveryTime: normalizeText($('deliveryTime').value, 10),
    pickupDate: addDays(eventDate, 1),
    pickupTime: normalizeText($('pickupTime').value, 10),
    chairs: totals.chairs,
    tables: totals.tables,
    auxTables: totals.auxTables,
    pricingMode: totals.pricingMode,
    linens: totals.linens,
    rental: totals.rental,
    deposit: totals.deposit,
    name: normalizeText($('customerName').value, 120),
    phone: normalizePhone($('customerPhone').value),
    email: normalizeEmail($('customerEmail').value),
    address: normalizeText($('eventAddress').value, 180),
    neighborhood: normalizeText($('neighborhood').value, 40),
    birthday: $('birthday').value,
    marketingConsent: Boolean($('marketingConsent')?.checked),
    notes: normalizeText($('notes').value, CONFIG.maxNotesLength),
    status: 'pending_payment',
    createdAt: new Date().toISOString()
  };
}

function rateLimitOK() {
  const now = Date.now();
  let attempts = [];
  try { attempts = JSON.parse(sessionStorage.getItem(CONFIG.rateLimit.key) || '[]'); } catch { attempts = []; }
  attempts = attempts.filter((ts) => Number(ts) > now - CONFIG.rateLimit.windowMs);
  if (attempts.length >= CONFIG.rateLimit.max) return false;
  attempts.push(now);
  sessionStorage.setItem(CONFIG.rateLimit.key, JSON.stringify(attempts));
  return true;
}

function validateBooking(data) {
  if (!rateLimitOK()) return 'Demasiados intentos. Espera unos minutos antes de volver a reservar.';
  if (!isValidDateString(data.eventDate) || data.eventDate < todayISO()) return 'Elige una fecha válida para tu evento.';
  if (!deliveryHours(data.eventDate).length || !data.deliveryTime) return 'Por ahora la entrega solo está disponible viernes, sábado y domingo.';
  if (!CONFIG.pickupHours.map(timeLabel).includes(data.pickupTime)) return 'Elige un horario válido de recolección.';
  if (!CONFIG.coverage.includes(data.neighborhood)) return 'Por ahora solo cubrimos Polanco y Anzures.';
  if (!deliveryHours(data.eventDate).map(timeLabel).includes(data.deliveryTime)) return 'Elige un horario válido de entrega.';
  if (!data.name || data.name.length < 3) return 'Escribe tu nombre completo.';
  if (!isValidEmail(data.email)) return 'Escribe un correo electrónico válido.';
  if (!data.phone || data.phone.replace(/\D/g, '').length < 10) return 'Escribe un teléfono válido a 10 dígitos.';
  if (!data.address || data.address.length < 8) return 'Escribe una dirección completa para el evento.';
  if (data.chairs < 10 && data.tables < 1 && data.auxTables < 1) return 'El pedido mínimo es 1 mesa o 10 sillas.';
  if (data.chairs > CONFIG.capacity.chairs || data.tables > CONFIG.capacity.tables || data.auxTables > CONFIG.capacity.auxTables) return 'La cantidad supera nuestro inventario total.';
  if (data.linens > CONFIG.capacity.linens) return 'La cantidad de linos supera nuestro inventario total.';
  if (data.birthday && (!isValidDateString(data.birthday) || data.birthday > todayISO())) return 'La fecha de cumpleaños no es válida.';
  if (data.notes.length > CONFIG.maxNotesLength) return 'Las notas de entrega son demasiado largas.';
  if (isSameDay(data.eventDate) && normalizeText($('sameDayCode').value, 40) !== CONFIG.sameDayCode) return 'Para reservas del mismo día necesitas el código de confirmación de WhatsApp.';
  if (!$('acceptTerms').checked) return 'Debes aceptar términos, aviso de privacidad y contrato de renta.';
  return null;
}


function buildDateTime(dateStr, timeStr) {
  if (!isValidDateString(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr || '')) return '';
  return `${dateStr}T${timeStr}:00-06:00`;
}

async function callReservationService(payload) {
  const response = await fetch(CONFIG.reservationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error('Zurich no pudo leer la respuesta del servidor.');
  }

  if (!response.ok) {
    if (result.error === 'Insufficient inventory') {
      throw new Error(`No hay inventario suficiente de ${result.item_name || 'ese mobiliario'}. Disponibles: ${result.available ?? 0}.`);
    }
    throw new Error(result.message || result.error || 'No pudimos procesar la reservación.');
  }

  return result;
}

async function checkAvailabilityRemote(data) {
  return callReservationService({
    action: 'check_availability',
    event_date: data.eventDate,
    delivery_at: buildDateTime(data.eventDate, data.deliveryTime),
    pickup_at: buildDateTime(data.pickupDate, data.pickupTime)
  });
}

async function createReservationRemote(data) {
  return callReservationService({
    action: 'create_reservation',
    customer: {
      full_name: data.name,
      email: data.email,
      phone: data.phone,
      birthday: data.birthday || null,
      marketing_consent: data.marketingConsent
    },
    event_date: data.eventDate,
    event_address: data.address,
    neighborhood: data.neighborhood,
    delivery_notes: data.notes || null,
    delivery_at: buildDateTime(data.eventDate, data.deliveryTime),
    pickup_at: buildDateTime(data.pickupDate, data.pickupTime),
    chairs_qty: data.chairs,
    tables_qty: data.tables,
    aux_tables_qty: data.auxTables,
    package_type: data.pricingMode === 'package' ? activePackage : 'custom'
  });
}


async function callCheckoutService(payload) {
  const response = await fetch(CONFIG.checkoutEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error('Zurich no pudo leer la respuesta de pago.');
  }

  if (!response.ok) {
    if (result.error === 'Reservation hold expired') {
      throw new Error('El apartado de 30 minutos venció. Revisa disponibilidad y vuelve a intentarlo.');
    }
    throw new Error(result.message || result.error || 'No pudimos iniciar el pago.');
  }

  return result;
}

async function createCheckoutSessionRemote(reservation, data) {
  return callCheckoutService({
    action: 'create_checkout_session',
    reservation_id: reservation.reservation_id,
    reservation_number: reservation.reservation_number,
    customer_email: data.email,
    origin: window.location.origin
  });
}

async function getReservationStatusRemote(reservation) {
  return callCheckoutService({
    action: 'get_reservation_status',
    reservation_id: reservation.reservation_id,
    reservation_number: reservation.reservation_number,
    customer_email: reservation.customer_email
  });
}

async function getCheckoutStatusRemote(sessionId) {
  return callCheckoutService({
    action: 'get_session_status',
    session_id: sessionId
  });
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function setPaymentCountdownMessage(remainingMs) {
  const time = formatCountdown(remainingMs);
  if (remainingMs <= 5 * 60 * 1000) {
    $('paymentStatus').textContent = `Tu apartado está por vencer · Completa tu pago en ${time}.`;
    return;
  }
  $('paymentStatus').textContent = `Tu mobiliario sigue apartado · Tiempo restante: ${time}.`;
}

function showExpiredReservationState(reservation) {
  stopHoldCountdown();
  holdExpirationInProgress = false;

  if (embeddedCheckout) {
    embeddedCheckout.destroy();
    embeddedCheckout = null;
  }

  clearActiveReservation();
  $('paymentReservationNumber').textContent = reservation?.reservation_number || '';
  $('paymentTotal').textContent = money(reservation?.total_amount);
  $('paymentStatus').textContent = 'Tu apartado terminó. Para mostrarte disponibilidad real, necesitamos revisar nuevamente tu fecha.';
  $('bookingForm').classList.add('hidden');
  $('paymentPanel').classList.remove('hidden');

  const checkout = $('checkout');
  clearChildren(checkout);
  const availabilityButton = el('button', { class: 'primary', type: 'button', text: 'Ver disponibilidad' });
  availabilityButton.addEventListener('click', () => {
    $('paymentPanel').classList.add('hidden');
    $('bookingForm').classList.remove('hidden');
    $('bookingStart').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('eventDate').focus();
  });
  checkout.append(availabilityButton);
}

async function expireReservationFromCountdown(reservation) {
  if (holdExpirationInProgress) return;
  holdExpirationInProgress = true;

  try {
    await getReservationStatusRemote(reservation);
  } catch (error) {
    console.warn('No se pudo confirmar la expiración del apartado.', error);
  }

  showExpiredReservationState(reservation);
}

function startHoldCountdown(reservation) {
  stopHoldCountdown();
  holdExpirationInProgress = false;

  const expiration = new Date(reservation?.hold_expires_at || '').getTime();
  if (!Number.isFinite(expiration)) {
    $('paymentStatus').textContent = 'Tu mobiliario sigue apartado mientras completas el pago.';
    return;
  }

  const tick = () => {
    const remaining = expiration - Date.now();
    if (remaining <= 0) {
      stopHoldCountdown();
      expireReservationFromCountdown(reservation);
      return;
    }
    setPaymentCountdownMessage(remaining);
  };

  tick();
  holdCountdownTimer = window.setInterval(tick, 1000);
}

function showResumePrompt(reservation) {
  activeReservation = reservation;
  $('paymentReservationNumber').textContent = reservation.reservation_number;
  $('paymentTotal').textContent = money(reservation.total_amount);
  $('bookingForm').classList.add('hidden');
  $('paymentPanel').classList.remove('hidden');
  startHoldCountdown(reservation);

  const checkout = $('checkout');
  clearChildren(checkout);
  const message = el('p', { text: '¡Ups! Parece que te desconectaste un momento. Tu mobiliario sigue apartado.' });
  const resumeButton = el('button', { class: 'primary', type: 'button', text: 'Volver a mi pago' });
  resumeButton.addEventListener('click', async () => {
    resumeButton.disabled = true;
    resumeButton.textContent = 'Abriendo tu pago…';
    try {
      await mountEmbeddedCheckout(reservation, { email: reservation.customer_email });
    } catch (error) {
      $('paymentStatus').textContent = error.message || 'No pudimos reabrir tu pago.';
      resumeButton.disabled = false;
      resumeButton.textContent = 'Volver a mi pago';
    }
  });
  checkout.append(message, resumeButton);
  $('paymentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function recoverActiveReservation() {
  const stored = readActiveReservation();
  if (!stored) return;

  try {
    const status = await getReservationStatusRemote(stored);
    const reservation = {
      ...stored,
      total_amount: status.total_amount,
      hold_expires_at: status.hold_expires_at
    };

    if (!status.active) {
      if (status.status === 'Confirmado') {
        showConfirmedReservation(status.reservation_number || stored.reservation_number);
        clearActiveReservation();
        return;
      }
      showExpiredReservationState(reservation);
      return;
    }

    saveActiveReservation(reservation, stored.customer_email);
    showResumePrompt(reservation);
  } catch (error) {
    console.warn('No se pudo recuperar la reservación activa.', error);
    clearActiveReservation();
  }
}

function showConfirmedReservation(reservationNumber) {
  clearChildren($('successMessage'));
  $('successMessage').append(
    'Tu pago fue confirmado. Tu evento ',
    el('strong', { text: reservationNumber }),
    ' está confirmado.'
  );
  $('successDialog').showModal();
}

async function handleCheckoutComplete() {
  if (!activeReservation?.session_id) return;

  stopHoldCountdown();
  $('paymentStatus').textContent = 'Confirmando el estado de tu pago…';

  try {
    const status = await getCheckoutStatusRemote(activeReservation.session_id);
    if (status.payment_status === 'paid' && status.status === 'complete') {
      $('paymentStatus').textContent = 'Pago confirmado.';
      showConfirmedReservation(status.reservation_number || activeReservation.reservation_number);
      clearActiveReservation();
      if (embeddedCheckout) {
        embeddedCheckout.destroy();
        embeddedCheckout = null;
      }
      $('paymentPanel').classList.add('hidden');
      $('bookingForm').classList.remove('hidden');
      return;
    }

    if (status.status === 'expired') {
      showExpiredReservationState(activeReservation);
      return;
    }

    $('paymentStatus').textContent = 'No pudimos completar tu pago. Tu apartado sigue vigente y puedes intentarlo nuevamente.';
    startHoldCountdown(activeReservation);
  } catch (error) {
    $('paymentStatus').textContent = error.message || 'No pudimos confirmar el pago todavía.';
    startHoldCountdown(activeReservation);
  }
}

async function mountEmbeddedCheckout(reservation, data) {
  if (typeof window.Stripe !== 'function') {
    throw new Error('Stripe no pudo cargar. Recarga la página e inténtalo nuevamente.');
  }

  const session = await createCheckoutSessionRemote(reservation, data);

  if (embeddedCheckout) {
    embeddedCheckout.destroy();
    embeddedCheckout = null;
  }

  activeReservation = {
    ...reservation,
    customer_email: data.email || reservation.customer_email,
    session_id: session.session_id
  };
  saveActiveReservation(activeReservation, activeReservation.customer_email);

  $('paymentReservationNumber').textContent = reservation.reservation_number;
  $('paymentTotal').textContent = money(reservation.total_amount);
  $('bookingForm').classList.add('hidden');
  $('paymentPanel').classList.remove('hidden');
  startHoldCountdown(activeReservation);

  clearChildren($('checkout'));
  const stripe = window.Stripe(session.publishable_key);
  embeddedCheckout = await stripe.createEmbeddedCheckoutPage({
    fetchClientSecret: async () => session.client_secret,
    onComplete: handleCheckoutComplete
  });

  embeddedCheckout.mount('#checkout');
  $('paymentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') !== 'return' || !params.get('session_id')) return;

  try {
    const status = await getCheckoutStatusRemote(params.get('session_id'));
    if (status.payment_status === 'paid' && status.status === 'complete') {
      showConfirmedReservation(status.reservation_number || 'Zurich Eventos');
      clearActiveReservation();
    } else if (status.status === 'expired') {
      const stored = readActiveReservation();
      showExpiredReservationState(stored || {
        reservation_number: status.reservation_number,
        total_amount: 0
      });
    }
  } catch (error) {
    console.error('No se pudo verificar el regreso de Stripe.', error);
  } finally {
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
  }
}

function renderAdmin() {
  const content = $('adminContent');
  clearChildren(content);
  const bookings = getBookings().sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
  if (!bookings.length) {
    content.append(el('p', { text: 'No hay reservas demo todavía.' }));
    return;
  }
  const table = el('table', { class: 'admin-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Reserva', 'Fecha', 'Cliente', 'Inventario', 'Total', 'Depósito', 'Estado'].forEach((h) => headerRow.append(el('th', { text: h })));
  thead.append(headerRow);
  const tbody = el('tbody');
  bookings.forEach((b) => {
    const row = el('tr');
    row.append(el('td', { text: normalizeText(b.id, 40) }));
    row.append(el('td', {}, [dateFmt(b.eventDate), el('br'), normalizeText(b.deliveryTime, 10)]));
    row.append(el('td', {}, [normalizeText(b.customer, 80), el('br'), normalizeText(b.email, 254)]));
    row.append(el('td', {}, [`${clampInt(b.chairs, 0, CONFIG.capacity.chairs)} sillas`, el('br'), `${clampInt(b.tables, 0, CONFIG.capacity.tables)} mesas rectangulares`, el('br'), `${clampInt(b.auxTables, 0, CONFIG.capacity.auxTables)} mesas auxiliares`, el('br'), `${clampInt(b.linens, 0, CONFIG.capacity.linens)} manteles`]));
    row.append(el('td', { text: money(b.rental) }));
    row.append(el('td', { text: money(b.deposit) }));
    row.append(el('td', {}, [el('span', { class: 'badge', text: normalizeText(b.status, 40) })]));
    tbody.append(row);
  });
  table.append(thead, tbody);
  content.append(table);
}

function adminUnlocked() {
  return sessionStorage.getItem(CONFIG.adminSessionKey) === 'true';
}

function openAdmin() {
  // Static-site mitigation only. This is not real authorization.
  if (!adminUnlocked()) {
    const passcode = prompt(`Dashboard de demo solamente. Escribe: ${CONFIG.adminUnlockPhrase}`);
    if (passcode !== CONFIG.adminUnlockPhrase) {
      alert('Acceso cancelado. El dashboard real debe vivir detrás de login de administrador en backend.');
      return;
    }
    sessionStorage.setItem(CONFIG.adminSessionKey, 'true');
  }
  $('adminDialog').showModal();
  renderAdmin();
}

function initGalleries() {
  document.querySelectorAll('[data-gallery]').forEach((gallery) => {
    const slides = Array.from(gallery.querySelectorAll('.gallery-slide'));
    const dotsWrap = gallery.querySelector('.gallery-dots');
    let current = 0;
    const show = (index) => {
      current = (index + slides.length) % slides.length;
      slides.forEach((slide, i) => slide.classList.toggle('active', i === current));
      dotsWrap.querySelectorAll('button').forEach((dot, i) => {
        dot.classList.toggle('active', i === current);
        dot.setAttribute('aria-current', i === current ? 'true' : 'false');
      });
    };
    slides.forEach((slide, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = i === 0 ? 'active' : '';
      dot.setAttribute('aria-label', `Ver fotografía ${i + 1}`);
      dot.addEventListener('click', () => show(i));
      dotsWrap.append(dot);
    });
    gallery.querySelector('.prev').addEventListener('click', () => show(current - 1));
    gallery.querySelector('.next').addEventListener('click', () => show(current + 1));
    gallery.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') show(current - 1);
      if (event.key === 'ArrowRight') show(current + 1);
    });
    show(0);
  });
}

function init() {
  initGalleries();
  const min = todayISO();
  ['eventDate', 'formEventDate'].forEach((id) => { if ($(id)) $(id).min = min; });

  $('checkAvailabilityBtn').addEventListener('click', async () => {
    const d = $('eventDate').value;
    if (!isValidDateString(d)) {
      setStatus('Elige una fecha válida para revisar disponibilidad.');
      return;
    }

    $('formEventDate').value = d;
    updateTimeOptions();
    calc();

    const deliveryTime = $('deliveryTime').value;
    const pickupTime = $('pickupTime').value;

    if (!deliveryTime || !pickupTime) {
      setStatus('Por ahora la entrega está disponible viernes, sábado y domingo.');
      return;
    }

    setStatus('Revisando inventario real…');

    try {
      const data = collectData(true);
      const result = await checkAvailabilityRemote(data);
      const a = result.available;
      setStatus(`Disponibilidad real: ${a.chairs} sillas, ${a.tables} mesas rectangulares y ${a.aux_tables} mesa(s) auxiliar(es) para ${dateFmt(d)}.`);
      location.hash = 'reservar';
    } catch (error) {
      setStatus(error.message || 'No pudimos revisar disponibilidad en este momento.');
    }
  });

  $('formEventDate').addEventListener('change', () => { updateTimeOptions(); calc(); });
  ['deliveryTime', 'pickupTime'].forEach((id) => $(id).addEventListener('input', calc));
  ['chairsQty', 'tablesQty', 'auxTablesQty'].forEach((id) => $(id).addEventListener('input', () => { activePackage = 'custom'; document.querySelectorAll('.choice').forEach((b) => b.classList.toggle('active', b.dataset.package === 'custom')); calc(); }));
  document.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => applyPackage(b.dataset.package)));
  $('previewContractBtn').addEventListener('click', () => { renderContract(collectData(true)); $('contractDialog').showModal(); });
  $('printContractBtn').addEventListener('click', () => window.print());
  $('closeContractBtn').addEventListener('click', () => $('contractDialog').close());
  $('closeSuccessBtn').addEventListener('click', () => $('successDialog').close());

  $('bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = collectData(false);
    const err = validateBooking(data);
    if (err) {
      alert(err);
      return;
    }

    const submitButton = $('bookingForm').querySelector('button[type="submit"]');
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Preparando pago seguro…';

    try {
      const storedReservation = readActiveReservation();
      let reservation = null;

      if (storedReservation) {
        const status = await getReservationStatusRemote(storedReservation);
        if (status.active) {
          reservation = {
            ...storedReservation,
            total_amount: status.total_amount,
            hold_expires_at: status.hold_expires_at
          };
        } else {
          clearActiveReservation();
        }
      }

      if (!reservation) {
        reservation = await createReservationRemote(data);
        saveActiveReservation(reservation, data.email);
      }

      await mountEmbeddedCheckout(reservation, { email: reservation.customer_email || data.email });
      calc();
    } catch (error) {
      alert(error.message || 'No pudimos preparar el pago. Intenta nuevamente.');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });

  $('openAdminBtn').addEventListener('click', openAdmin);
  $('closeAdminBtn').addEventListener('click', () => $('adminDialog').close());
  $('clearBookingsBtn').addEventListener('click', () => {
    if (confirm('¿Limpiar reservas demo?')) { setBookings([]); renderAdmin(); calc(); }
  });
  $('exportBookingsBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(getBookings(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zurich-bookings-demo.json';
    a.rel = 'noopener';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  updateTimeOptions();
  calc();
  handleCheckoutReturn();
  recoverActiveReservation();
}

init();
