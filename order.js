// The order form: one type-and-size row per pair, a running total, and sending the order to the shop's
// Google Apps Script (orders/Code.gs), which adds it to a Google Sheet. There is no server of our own.
//
// The page says "order received" only when the script answers that it saved the order. Until then the
// order is kept in this browser. If sending fails, the customer can send it again (same order number,
// so it's never saved twice) or copy it into Messenger, and it's offered again on their next visit.

// The Apps Script web app link (Deploy > Web app, ends in /exec).
const ORDER_URL = "https://script.google.com/macros/s/AKfycbzXPmSvraL-UHyjxXqssWgzIouuxcp2MYWo5z5dy9C9e4LcZII4oV8ymccSky3qDYnF/exec";
const TRIES = 3;
const TIMEOUT = 15000;
const PENDING_KEY = "gembuybd-pending-order";

const PACKS = { 1: 390, 2: 690, 3: 990 };
const DELIVERY = {
  dhaka: { label: "ঢাকা সিটির ভিতরে", fee: 70 },
  outside: { label: "ঢাকা সিটির বাইরে", fee: 130 },
};
const SIZES = ["৩৭/৩৮", "৩৯/৪০", "৪১/৪২"];
// What's in stock: the white one only came in 39/40.
const PRODUCTS = {
  lime: { name: "লাইম-গ্রে 4D ক্লাউড", sizes: SIZES },
  white: { name: "সাদা ক্লাউড", sizes: ["৩৯/৪০"] },
};
// Letters and digits that can't be confused when read out over the phone (no 0/O or 1/I).
const ID_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const form = document.getElementById("order-form");
const fields = form.elements;
const rows = document.getElementById("pair-rows");
const totalBox = document.getElementById("order-total");
const errorBox = document.getElementById("order-error");
const button = form.querySelector("button[type=submit]");
const done = document.getElementById("order-done");
const pending = document.getElementById("order-pending");
const pendingText = document.getElementById("pending-text");
const pendingStatus = document.getElementById("pending-status");
const sendAgain = document.getElementById("pending-send");
// The order shown in the pending panel.
let waiting = null;

const bangla = (n) => n.toLocaleString("bn-BD");
const taka = (n) => "৳" + bangla(n);

function option(value, text, disabled = false) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  o.disabled = disabled;
  return o;
}

// Sizes the chosen type doesn't come in stay listed but can't be picked; a type with one size picks it.
function fillSizes(product, size) {
  const sizes = PRODUCTS[product.value].sizes;
  const kept = sizes.includes(size.value) ? size.value : "";
  size.replaceChildren(option("", "সাইজ বাছুন", true),
                       ...SIZES.map((s) => option(s, sizes.includes(s) ? s : `${s} (নেই)`, !sizes.includes(s))));
  size.value = sizes.length === 1 ? sizes[0] : kept;
}

function pairRow(n) {
  const row = document.createElement("div");
  row.className = "pair";
  const label = document.createElement("span");
  label.textContent = `জোড়া ${bangla(n + 1)}`;
  const product = document.createElement("select");
  product.setAttribute("aria-label", `জোড়া ${bangla(n + 1)}: ধরন`);
  product.append(...Object.entries(PRODUCTS).map(([key, p]) => option(key, p.name)));
  const size = document.createElement("select");
  size.setAttribute("aria-label", `জোড়া ${bangla(n + 1)}: সাইজ`);
  fillSizes(product, size);
  product.addEventListener("change", () => fillSizes(product, size));
  row.append(label, product, size);
  return row;
}

// Rows are added or removed at the end, so pairs already chosen keep their type and size.
function setPairs(count) {
  while (rows.children.length < count) rows.append(pairRow(rows.children.length));
  while (rows.children.length > count) rows.lastElementChild.remove();
}

function current() {
  const pairs = Number(fields.pairs.value);
  const items = [...rows.children].map((row) => {
    const [product, size] = row.querySelectorAll("select");
    return { name: PRODUCTS[product.value].name, size: size.value, select: size };
  });
  const area = DELIVERY[fields.area.value];
  return { pairs, items, area, price: PACKS[pairs], total: PACKS[pairs] + (area ? area.fee : 0) };
}

function showTotal() {
  const order = current();
  const parts = document.createElement("span");
  parts.textContent = order.area
    ? `ইনসোল ${taka(order.price)} + ডেলিভারি ${taka(order.area.fee)}`
    : `ইনসোল ${taka(order.price)} + ডেলিভারি (কোথায় পাঠাবো বাছুন)`;
  const sum = document.createElement("strong");
  sum.textContent = `মোট ${taka(order.total)}`;
  totalBox.replaceChildren(parts, ...(order.area ? [sum] : []));
}

// Accepts Bangla digits, spaces, dashes and a +88 prefix; gives 01XXXXXXXXX or null.
function cleanPhone(raw) {
  const digits = raw.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).replace(/\D/g, "");
  const local = digits.startsWith("880") ? digits.slice(2) : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}

function problem(order) {
  const missing = order.items.find((item) => !item.size);
  if (missing) return [missing.select, "প্রতিটি জোড়ার সাইজ বাছুন।"];
  if (fields.name.value.trim().length < 2) return [fields.name, "আপনার নাম লিখুন।"];
  if (!cleanPhone(fields.phone.value)) return [fields.phone, "১১ ডিজিটের মোবাইল নম্বর লিখুন, যেমন 01712345678।"];
  if (!order.area) return [fields.area[0], "ডেলিভারি কোথায় হবে বাছুন।"];
  if (fields.address.value.trim().length < 8) return [fields.address, "পুরো ঠিকানা লিখুন: বাসা, এলাকা, থানা, জেলা।"];
  return null;
}

function showError(text, field) {
  errorBox.textContent = text;
  errorBox.hidden = false;
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  field.setAttribute("aria-invalid", "true");
  field.focus();
}

function newId() {
  return "GB-" + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => ID_CHARS[b % 32]).join("");
}

// What gets sent, saved in the browser and shown for copying: plain text fields only.
function record(order) {
  return {
    id: newId(),
    name: fields.name.value.trim(),
    phone: cleanPhone(fields.phone.value),
    area: order.area.label,
    address: fields.address.value.trim(),
    items: `${bangla(order.pairs)} জোড়া: ` + order.items.map((item) => `${item.name} ${item.size}`).join(", "),
    total: order.total,
    note: fields.note.value.trim(),
  };
}

function orderText(r) {
  return [`অর্ডার ${r.id}`, r.items, `মোট: ${taka(r.total)}`, `নাম: ${r.name}`, `ফোন: ${r.phone}`,
          `ঠিকানা: ${r.address} (${r.area})`, ...(r.note ? [`নোট: ${r.note}`] : [])].join("\n");
}

// Storage can be off (private mode, some in-app browsers); the order then lives only in this page.
function remember(r) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(r)); } catch {}
}
function forget() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}
function remembered() {
  try {
    const r = JSON.parse(localStorage.getItem(PENDING_KEY));
    return r && r.id && r.items ? r : null;
  } catch {
    return null;
  }
}

// Resolves only when the script answers that it saved this order. No network, a timeout, or a Google
// error or sign-in page instead of the JSON answer all throw.
async function post(r) {
  if (!ORDER_URL) throw new Error("ORDER_URL is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    // A plain-text body keeps this a "simple" request; Apps Script can't answer a CORS preflight.
    const response = await fetch(ORDER_URL, { method: "POST", body: JSON.stringify(r), signal: controller.signal });
    const answer = await response.json();
    if (!answer.ok || answer.order !== r.id) throw new Error(answer.error || "order not saved");
  } finally {
    clearTimeout(timer);
  }
}

// A resend carries the same order number, so a try that saved the order but lost the answer isn't saved twice.
async function send(r, retrying) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await post(r);
    } catch (error) {
      if (attempt === TRIES) throw error;
      retrying();
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function reveal(panel) {
  form.hidden = true;
  for (const p of [done, pending]) p.hidden = p !== panel;
  panel.focus();
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
}

function finish(r) {
  document.getElementById("done-id").textContent = r.id;
  document.getElementById("done-summary").textContent =
    `${r.items}। মোট ${taka(r.total)}, ইনসোল হাতে পেয়ে দিবেন। শীঘ্রই ${r.phone} নম্বরে কল করে কনফার্ম করবো।`;
  reveal(done);
}

function showPending(r, status = "") {
  waiting = r;
  pendingText.value = orderText(r);
  pendingStatus.textContent = status;
}

async function deliver(r, trigger) {
  remember(r);
  const label = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = "পাঠানো হচ্ছে…";
  try {
    await send(r, () => (trigger.textContent = "আবার চেষ্টা করছি…"));
    forget();
    finish(r);
  } catch (error) {
    console.warn("order not confirmed", error);
    showPending(r, trigger === sendAgain ? "এবারও পাঠানো যায়নি। লেখাটা কপি করে মেসেঞ্জারে পাঠিয়ে দিন।" : "");
    reveal(pending);
  } finally {
    trigger.disabled = false;
    trigger.textContent = label;
  }
}

async function submit(event) {
  event.preventDefault();
  const order = current();
  const found = problem(order);
  if (found) return showError(found[1], found[0]);
  errorBox.hidden = true;
  // A bot filled the field people can't see: look successful, send nothing.
  if (fields.website.value) return finish(record(order));
  await deliver(record(order), button);
}

async function copyOrder() {
  try {
    await navigator.clipboard.writeText(pendingText.value);
    pendingStatus.textContent = "কপি হয়েছে। এখন মেসেঞ্জারে পেস্ট করে পাঠান।";
  } catch {
    pendingText.focus();
    pendingText.select();
    pendingStatus.textContent = "লেখাটা সিলেক্ট করা আছে। কপি করে মেসেঞ্জারে পাঠান।";
  }
}

function dropPending() {
  forget();
  waiting = null;
  pending.hidden = true;
  form.hidden = false;
  form.scrollIntoView({ block: "start", behavior: "smooth" });
}

// Fixing a field clears its red mark; for radio buttons, the whole group's.
function unmark(event) {
  const group = event.target.type === "radio" ? [...fields[event.target.name]] : [event.target];
  group.forEach((el) => el.removeAttribute("aria-invalid"));
}

form.addEventListener("change", (event) => {
  if (event.target.name === "pairs") setPairs(Number(fields.pairs.value));
  unmark(event);
  showTotal();
});
form.addEventListener("input", unmark);
form.addEventListener("submit", submit);
sendAgain.addEventListener("click", () => deliver(waiting, sendAgain));
document.getElementById("pending-copy").addEventListener("click", copyOrder);
document.getElementById("pending-drop").addEventListener("click", dropPending);
setPairs(Number(fields.pairs.value));
showTotal();

// An order from an earlier visit that was never confirmed: offer it again instead of the empty form.
const left = remembered();
if (left) {
  showPending(left);
  form.hidden = true;
  pending.hidden = false;
}
