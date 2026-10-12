// server.js — WhatsApp Flows back end
//
//   GET  /webhook        Meta's one-time URL verification
//   POST /webhook        chat events: "Hi" (start) and Flow completed (finish)
//   POST /flow-endpoint  called by the WhatsApp app while the Flow is open
//
// Run:  npm install express  &&  node server.js     (Node 18+)
//
// TESTING PHASE: with no CORE_BASE_URL set, every API call is answered by the
// MOCK data in section 1b, so this one file is all you need. Set CORE_BASE_URL
// (and fill in the paths in CORE) to switch to your real APIs.
// With no PRIVATE_KEY / PRIVATE_KEY_FILE, a key pair is created next to this
// file on first run and the public key is printed for you to upload to Meta.
// With no WA_TOKEN, outgoing chat messages are printed instead of sent.

import express from "express";
import crypto from "crypto";
import fs from "fs";

let {
  PORT = "3000",
  PRIVATE_KEY,            // PEM of the RSA key whose public half is uploaded to Meta
  PRIVATE_KEY_FILE,       // or: path to that PEM file
  PASSPHRASE = "",        // passphrase of PRIVATE_KEY, if any
  APP_SECRET,             // Meta app secret, for X-Hub-Signature-256
  VERIFY_TOKEN,           // any string; the same one you type in the App Dashboard
  WA_TOKEN,               // system user access token
  PHONE_NUMBER_ID,        // the business phone number id
  FLOW_ID,                // the published Flow's id
  GRAPH_VERSION = "v25.0",
  GRAPH_BASE = "https://graph.facebook.com",
  CORE_BASE_URL,          // your back end; NOT set = use the MOCK data below
  TEST_PHONE,             // LOCAL TESTING ONLY (e.g. with flowso): unknown flow_tokens get a session for this number. Never set in production.
} = process.env;

const USE_MOCK = true;

// ---- private key: env, file, or a new pair created on first run
if (!PRIVATE_KEY) {
  const file = PRIVATE_KEY_FILE || "private.pem";
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    fs.writeFileSync(file, pair.privateKey);
    fs.writeFileSync("public.pem", pair.publicKey);
    console.log("Created private.pem and public.pem. Upload this public key to Meta");
    console.log("(POST /<phone-number-id>/whatsapp_business_encryption, field business_public_key):\n");
    console.log(pair.publicKey);
  }
  PRIVATE_KEY = fs.readFileSync(file, "utf8");
}

// =====================================================================
// 1. YOUR EXISTING APIs (placeholders) — numbers = the handover sheet S#
// =====================================================================
const CORE = {
  folios:          { n: 1,  method: "POST", path: "/TODO/folios" },
  balance:         { n: 2,  method: "POST", path: "/TODO/balance" },
  statement:       { n: 3,  method: "POST", path: "/TODO/statement" },
  existingFunds:   { n: 4,  method: "POST", path: "/TODO/existing-funds" },
  newFunds:        { n: 5,  method: "POST", path: "/TODO/new-funds" },
  existingRaast:   { n: 6,  method: "POST", path: "/TODO/existing-funds-raast" },
  newRaast:        { n: 7,  method: "POST", path: "/TODO/new-funds-raast" },
  investQuote:     { n: 8,  method: "POST", path: "/TODO/investment-quote" },
  investBill:      { n: 9,  method: "POST", path: "/TODO/investment-bill" },
  swiftLimits:     { n: 11, method: "POST", path: "/TODO/swiftpay-limits" },
  transferQuote:   { n: 12, method: "POST", path: "/TODO/f2f-quote" },
  otpSend:         { n: 13, method: "POST", path: "/TODO/otp/generate" },
  otpVerify:       { n: 14, method: "POST", path: "/TODO/otp/verify" },
  redeemNormal:    { n: 15, method: "POST", path: "/TODO/redemption/normal" },
  redeemSwift:     { n: 16, method: "POST", path: "/TODO/redemption/swiftpay" },
  fundToFund:      { n: 17, method: "POST", path: "/TODO/fund-to-fund" },
  taxCertificate:  { n: 18, method: "POST", path: "/TODO/tax-certificate" },
  digitalStatus:   { n: 19, method: "POST", path: "/TODO/digital-status" },
  referrerCheck:   { n: 20, method: "POST", path: "/TODO/referrer/check" },
  referrerAdd:     { n: 21, method: "POST", path: "/TODO/referrer/register" },
  complaint:       { n: 22, method: "POST", path: "/TODO/complaint" },
  feedback:        { n: 23, method: "POST", path: "/TODO/feedback" },
  meeting:         { n: 24, method: "POST", path: "/TODO/meeting" },
  agent:           { n: 25, method: "POST", path: "/TODO/agent-handover" },
  language:        { n: 26, method: "POST", path: "/TODO/language" },
};
// API #10 (terms and conditions) is a fixed link in flow.json.

async function callCore(name, body) {
  if (USE_MOCK) {
    const out = MOCK[name](body);
    console.log(`  mock API #${CORE[name].n} ${name}`, JSON.stringify(body));
    return structuredClone(out);
  }
  const { method, path } = CORE[name];
  const res = await fetch(CORE_BASE_URL + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000), // the whole Flow reply must be under 10 s
  });
  if (!res.ok) throw new Error(`API #${CORE[name].n} ${name} returned HTTP ${res.status}`);
  return res.json();
}

// =====================================================================
// 1b. MOCK DATA — used while CORE_BASE_URL is not set (testing phase)
// =====================================================================
// Edit these to test other cases. The test OTP is MOCK_OTP.
const MOCK_OTP = "123456";
const MOCK_FOLIOS = [
  { folioNo: "41027", type: "Mutual Fund", balance: 8150316.97, iban: "PK00TEST0000000041027001" },
  { folioNo: "58310", type: "Pension Fund - Regular", balance: 95000, iban: "PK00TEST0000000058310001" },
];
const MOCK_HELD = [
  { code: "MAF", name: "Asset Allocation Fund", amount: 2155.15, units: 203.6238 },
  { code: "MSF", name: "Stock Fund", amount: 4231216.41, units: 102739.3263 },
];
const MOCK_NEW = [
  { code: "MCF", name: "Cash Fund", risk: "Low", category: "conventional" },
  { code: "MIF", name: "Income Fund", risk: "Medium", category: "conventional" },
  { code: "MIMF", name: "Islamic Money Market", risk: "Low", category: "islamic" },
  { code: "MISF", name: "Islamic Stock Fund", risk: "High", category: "islamic" },
];
const MOCK_SWIFT_LIMITS = [{ code: "MAF", limit: 1900 }, { code: "MSF", limit: 3800000 }];
const withIban = (f) => ({ ...f, iban: `PK00TEST${f.code.padEnd(6, "0")}0000001`, raastId: `RAAST-${f.code}` });
let mockTxn = 1040640;

const MOCK = {
  folios: () => MOCK_FOLIOS,
  balance: () => MOCK_FOLIOS,
  statement: () => ({ ok: true }),
  existingFunds: () => MOCK_HELD,
  newFunds: () => MOCK_NEW,
  existingRaast: () => MOCK_HELD.map(withIban),
  newRaast: () => MOCK_NEW.map(withIban),
  investQuote: (b) => ({ loadPercent: 0, loadAmount: 0, netAmount: Number(b.amount), kfsUrl: "https://example.com/kfs" }),
  investBill: (b) => ({ billNumber: "1062" + b.folioNo, charges: 80, total: Number(b.amount) + 80, payLink: "https://example.com/pay" }),
  swiftLimits: () => MOCK_SWIFT_LIMITS,
  transferQuote: (b) => ({ loadPercent: 0, loadAmount: 0, netAmount: Number(b.amount), kfsUrl: "https://example.com/kfs" }),
  otpSend: () => { console.log(`  >>> mock OTP is ${MOCK_OTP}`); return { ok: true, otpRef: "REF1" }; },
  otpVerify: (b) => ({ valid: String(b.otp) === MOCK_OTP }),
  redeemNormal: () => ({ ok: true, txnId: String(++mockTxn), iban: MOCK_FOLIOS[0].iban }),
  redeemSwift: () => ({ ok: true, txnId: String(++mockTxn), iban: MOCK_FOLIOS[0].iban }),
  fundToFund: () => ({ ok: true, txnId: String(++mockTxn) }),
  taxCertificate: () => ({ ok: true }),
  digitalStatus: () => ({ debitCard: "Card activated", eBanking: "Activated", tele: "Not applied", sms: "Not applied" }),
  referrerCheck: () => ({ registered: false }),
  referrerAdd: (b) => (/^\d{4,8}$/.test(String(b.sapCode)) ? { ok: true } : { ok: false, reason: "Invalid staff code." }),
  complaint: () => ({ ok: true, ticket: "CMP-" + ++mockTxn }),
  feedback: () => ({ ok: true }),
  meeting: () => ({ ok: true }),
  agent: () => ({ ok: true }),
  language: () => ({ ok: true }),
};

// Each function returns the shape the screens below expect.
// TODO: map your real field names inside these functions only.
const api = {
  // -> [{ folioNo, type, balance, iban }]
  getFolios: (mobile) => callCore("folios", { mobile }),
  // -> [{ folioNo, type, balance }]
  getBalance: (mobile) => callCore("balance", { mobile }),
  // -> { ok, pdfUrl? }
  emailStatement: (mobile, folioNo, period) => callCore("statement", { mobile, folioNo, period }),
  // -> [{ code, name, amount, units }]
  getExistingFunds: (mobile, folioNo) => callCore("existingFunds", { mobile, folioNo }),
  // -> [{ code, name, risk, category }]   category: "islamic" | "conventional"
  getNewFunds: (mobile, folioNo) => callCore("newFunds", { mobile, folioNo }),
  // -> [{ code, name, iban, raastId }]
  getExistingRaast: (mobile, folioNo) => callCore("existingRaast", { mobile, folioNo }),
  getNewRaast: (mobile, folioNo) => callCore("newRaast", { mobile, folioNo }),
  // -> { loadPercent, loadAmount, netAmount, kfsUrl }
  investQuote: (mobile, folioNo, fund, amount) => callCore("investQuote", { mobile, folioNo, fund, amount }),
  // -> { billNumber, charges, total, payLink } or { error }
  investBill: (mobile, folioNo, fund, amount) => callCore("investBill", { mobile, folioNo, fund, amount }),
  // -> [{ code, limit }]
  getSwiftLimits: (mobile, folioNo) => callCore("swiftLimits", { mobile, folioNo }),
  // -> { loadPercent, loadAmount, netAmount, kfsUrl }
  transferQuote: (mobile, p) => callCore("transferQuote", { mobile, ...p }),
  // -> { ok, otpRef? }
  sendOtp: (mobile, txnType) => callCore("otpSend", { mobile, txnType }),
  // -> { valid, expired? }
  verifyOtp: (mobile, otp, otpRef) => callCore("otpVerify", { mobile, otp, otpRef }),
  // -> { ok, txnId, iban } or { ok: false, reason }
  redeem: (mobile, p) => callCore(p.swift ? "redeemSwift" : "redeemNormal", { mobile, ...p }),
  // -> { ok, txnId } or { ok: false, reason }
  fundToFund: (mobile, p) => callCore("fundToFund", { mobile, ...p }),
  // -> { ok, pdfUrl? }
  emailTaxCertificate: (mobile, folioNo, year) => callCore("taxCertificate", { mobile, folioNo, year }),
  // -> { debitCard, eBanking, tele, sms }
  getDigitalStatus: (mobile, folioNo) => callCore("digitalStatus", { mobile, folioNo }),
  // -> { registered }
  isReferrer: (mobile) => callCore("referrerCheck", { mobile }),
  // -> { ok } or { ok: false, reason }
  registerReferrer: (mobile, sapCode) => callCore("referrerAdd", { mobile, sapCode }),
  // -> { ok, ticket? }
  complaint: (mobile, folioNo, text) => callCore("complaint", { mobile, folioNo, text }),
  feedback: (mobile, text) => callCore("feedback", { mobile, text }),
  meeting: (mobile) => callCore("meeting", { mobile }),
  agent: (mobile) => callCore("agent", { mobile }),
  saveLanguage: (mobile, language) => callCore("language", { mobile, language }),
};

// WhatsApp sends 923001234567; change this if your APIs expect another format.
const toCoreMobile = (waId) => (waId.startsWith("92") ? "0" + waId.slice(2) : waId);

// =====================================================================
// 2. SESSIONS — flow_token <-> phone number
// =====================================================================
// TODO: replace the Map with a database table (one row per flow_token).
const sessions = new Map();
const TOKEN_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000; // Meta suggests 2-3 days

// New session when the customer says Hi. Returns the flow_token.
function createSession(waId, token = crypto.randomBytes(24).toString("hex")) {
  sessions.set(token, {
    token,
    waId,                       // WhatsApp number, for sending messages
    mobile: toCoreMobile(waId), // number in your APIs' format
    status: "OPEN",             // OPEN | COMPLETED | LOCKED
    expiresAt: Date.now() + TOKEN_LIFETIME_MS,
    pending: null,              // the transaction the OTP will confirm
    otpRef: null,
    otpAttempts: 0,
    result: null,               // what happened; used for the chat summary
  });
  return token;
}

// Resolve a flow_token to its session (and so to the phone number).
function getSession(token) {
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

function saveSession(s) {
  sessions.set(s.token, s);
}

// =====================================================================
// 3. META: sending messages (Cloud API)
// =====================================================================
async function sendMessage(payload) {
  if (!WA_TOKEN) {
    // testing without Meta credentials: show what would be sent
    console.log("  (no WA_TOKEN) would send:", JSON.stringify(payload));
    return;
  }
  const res = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  if (!res.ok) console.error("send failed", res.status, await res.text());
}

const sendText = (to, body) => sendMessage({ to, type: "text", text: { body } });

const sendDocument = (to, link, filename, caption) =>
  sendMessage({ to, type: "document", document: { link, filename, caption } });

const sendFlow = (to, token, text) =>
  sendMessage({
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_id: FLOW_ID,
          flow_cta: "Open services",
          flow_token: token,
          flow_action: "data_exchange", // the endpoint gets INIT when the Flow opens
        },
      },
    },
  });

// =====================================================================
// 4. ENCRYPTION and SIGNATURE (Meta's documented scheme)
// =====================================================================
function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const aesKey = crypto.privateDecrypt(
    { key: crypto.createPrivateKey({ key: PRIVATE_KEY, passphrase: PASSPHRASE }), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );
  const data = Buffer.from(encrypted_flow_data, "base64");
  const iv = Buffer.from(initial_vector, "base64");
  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(data.subarray(-16));
  const json = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf-8");
  return { request: JSON.parse(json), aesKey, iv };
}

function encryptResponse(obj, aesKey, iv) {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(obj), "utf-8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

function signatureOk(req) {
  if (!APP_SECRET) return true; // only while testing locally
  const theirs = Buffer.from((req.get("x-hub-signature-256") || "").replace("sha256=", ""));
  const ours = Buffer.from(crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex"));
  return theirs.length === ours.length && crypto.timingSafeEqual(theirs, ours);
}

// =====================================================================
// 5. SCREENS — what each Flow screen does (names match flow.json)
// =====================================================================
const SERVICES = [
  { id: "account", title: "Balance and statement", description: "Folio balances or a PDF statement" },
  { id: "invest", title: "Invest online", description: "Bill generation or IBFT / RAAST" },
  { id: "redeem", title: "Withdraw / redeem", description: "Normal or SwiftPay redemption" },
  { id: "transfer", title: "Change your fund", description: "Fund to fund transfer" },
  { id: "company", title: "Company and products", description: "About us, products, services" },
  { id: "fmr", title: "Fund manager report, NAV", description: "Monthly report and daily prices" },
  { id: "services", title: "Certificates and services", description: "Tax certificate, activation status" },
  { id: "refer", title: "Refer a client", description: "Register as a referrer" },
  { id: "support", title: "Complaint or agent", description: "Complaint, feedback, meeting, agent" },
  { id: "card", title: "Debit card, my details", description: "Apply or update personal details" },
  { id: "language", title: "Language / زبان", description: "English or Urdu" },
];
const REASONS = { cash: "Cash requirement", returns: "Low returns of fund", service: "Unsatisfactory customer service" };
const PERIODS = ["1m", "3m", "6m", "1y", "inception", "last_fy", "fy_to_date"];
const MIN_AMOUNT = 500;

const pkr = (n) => "PKR " + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amountOf = (v) => (/^\d+(\.\d{1,2})?$/.test(String(v || "").trim()) ? Number(v) : null);
const NONE = [{ id: "none", title: "No funds", description: "Choose the options above first" }];

const screen = (name, data) => ({ screen: name, data });
const folioOptions = (folios) => folios.map((f) => ({ id: String(f.folioNo), title: `Folio ${f.folioNo}`, description: `${f.type} - ${pkr(f.balance)}` }));
const fundOptions = (funds, describe) => funds.map((f) => ({ id: f.code, title: f.code, description: describe(f) }));

const menu = (s, error) => screen("MENU", { greeting: "Choose a service", services: SERVICES, ...(error ? { error_message: error } : {}) });
const info = (heading, body) => screen("INFO", { heading, body });
// Show the screen the customer is already on again, with an error. Going
// "back" to another screen from the server is not allowed by Meta's routing.
const stay = (s, message) => (s.lastScreen ? screen(s.lastScreen.screen, { ...s.lastScreen.data, error_message: message }) : menu(s, message));

// Ends the Flow. The rest (summary message, emails) happens in onFlowCompleted.
function finish(s, result) {
  s.status = "COMPLETED";
  s.result = result;
  return screen("SUCCESS", { extension_message_response: { params: { flow_token: s.token, service: result.kind } } });
}

function review(heading, lines, note, cta) {
  return screen("REVIEW", {
    heading,
    summary: lines.join("\n"),
    note,
    terms: "I have read and accept the terms and conditions and disclaimers.",
    cta,
  });
}

// --- screen data builders (a refreshed screen must get ALL its data again)
async function investData(s, d) {
  const folios = folioOptions(await api.getFolios(s.mobile));
  let funds = [];
  if (d.folio && d.method && d.scope) {
    const ibft = d.method === "ibft";
    const list =
      d.scope === "existing"
        ? await (ibft ? api.getExistingRaast : api.getExistingFunds)(s.mobile, d.folio)
        : await (ibft ? api.getNewRaast : api.getNewFunds)(s.mobile, d.folio);
    funds = fundOptions(list, (f) => (f.risk ? `${f.name} - Risk: ${f.risk}` : f.name));
  }
  return { folios, funds: funds.length ? funds : NONE, has_funds: funds.length > 0 };
}

async function redeemData(s, d) {
  const folios = folioOptions(await api.getFolios(s.mobile));
  let funds = [];
  if (d.folio) {
    const held = await api.getExistingFunds(s.mobile, d.folio);
    const limits = d.type === "swift" ? await api.getSwiftLimits(s.mobile, d.folio) : [];
    funds = fundOptions(held, (f) => {
      const lim = limits.find((l) => l.code === f.code);
      return lim ? `${f.name} - limit ${pkr(lim.limit)}` : `${f.name} - ${pkr(f.amount)}`;
    });
  }
  return { folios, funds: funds.length ? funds : NONE, has_funds: funds.length > 0 };
}

async function transferData(s, d) {
  const folios = folioOptions(await api.getFolios(s.mobile));
  const from = d.folio ? await api.getExistingFunds(s.mobile, d.folio) : [];
  const to = d.folio && d.category ? (await api.getNewFunds(s.mobile, d.folio)).filter((f) => f.category === d.category && f.code !== d.from_fund) : [];
  return {
    folios,
    from_funds: from.length ? fundOptions(from, (f) => `${f.name} - ${pkr(f.amount)}`) : NONE,
    has_from: from.length > 0,
    to_funds: to.length ? fundOptions(to, (f) => `${f.name} - Risk: ${f.risk}`) : NONE,
    has_to: to.length > 0,
  };
}

// --- the dispatcher: one branch per screen
async function handleScreen(s, screenName, d) {
  // MENU: the customer picked a service
  if (screenName === "MENU") {
    if (d.service === "account") return screen("ACCOUNT", { folios: folioOptions(await api.getFolios(s.mobile)) });
    if (d.service === "invest") return screen("INVEST", await investData(s, {}));
    if (d.service === "redeem") return screen("REDEEM", await redeemData(s, {}));
    if (d.service === "transfer") return screen("TRANSFER", await transferData(s, {}));
    if (d.service === "services") return screen("SERVICES", { folios: folioOptions(await api.getFolios(s.mobile)) });
    if (d.service === "support") return screen("SUPPORT", { folios: folioOptions(await api.getFolios(s.mobile)) });
    if (d.service === "language") return screen("LANGUAGE", {});
    if (d.service === "refer") {
      const { registered } = await api.isReferrer(s.mobile);
      return registered ? info("Refer a client", "You are already registered as a referrer.") : screen("REFER", {});
    }
    if (d.service === "company")
      return screen("PICK", { heading: "What would you like to know?", topic: "company", options: [{ id: "about", title: "Company information" }, { id: "products", title: "Products" }, { id: "plans", title: "Services and plans" }] });
    if (d.service === "fmr")
      return screen("PICK", { heading: "Choose a report", topic: "fmr", options: [{ id: "report", title: "Fund manager report" }, { id: "nav", title: "Daily fund prices" }] });
    if (d.service === "card")
      return info("Debit card and personal details", "Apply for a debit card or update your details in the Investor Services Utility.\n\n[Open the utility](https://example.com/investor-services)");
    return menu(s, "Please choose a service.");
  }

  // ACCOUNT: balance now, or statement after the Flow closes
  if (screenName === "ACCOUNT") {
    if (d.request === "balance") {
      const rows = await api.getBalance(s.mobile);
      return info("Your folio balances", rows.map((f) => `**Folio ${f.folioNo}**\n${f.type}\nBalance: ${pkr(f.balance)}`).join("\n\n"));
    }
    if (!d.folio || !PERIODS.includes(d.period))
      return screen("ACCOUNT", { folios: folioOptions(await api.getFolios(s.mobile)), error_message: "Choose a folio and a period." });
    return finish(s, { kind: "statement", folio: d.folio, period: d.period });
  }

  // INVEST: lists depend on folio + method + fund type
  if (screenName === "INVEST") {
    if (d.component_action === "refresh") return screen("INVEST", await investData(s, d));
    const fail = async (m) => screen("INVEST", { ...(await investData(s, d)), error_message: m });
    if (!d.folio || !d.fund || d.fund === "none") return fail("Choose a folio and a fund.");

    if (d.method === "ibft") {
      const list = d.scope === "existing" ? await api.getExistingRaast(s.mobile, d.folio) : await api.getNewRaast(s.mobile, d.folio);
      const f = list.find((x) => x.code === d.fund);
      if (!f) return fail("Fund not found.");
      return info(`Invest in ${f.code} by bank transfer`, `**Fund IBAN (1Link):** ${f.iban}\n**RAAST ID:** ${f.raastId}\n\n1. Log in to your banking app.\n2. Add the IBAN or RAAST ID as a payee.\n3. Transfer the amount you want to invest.`);
    }

    const amount = amountOf(d.amount);
    if (amount === null) return fail("Enter the amount in digits, without commas.");
    const q = await api.investQuote(s.mobile, d.folio, d.fund, amount);
    s.pending = { kind: "invest", folio: d.folio, fund: d.fund, amount };
    return review(
      "Review your investment",
      [`**Folio:** ${d.folio}`, `**Fund:** ${d.fund}`, `**Amount:** ${pkr(amount)}`, `**Front-end load:** ${q.loadPercent}% (${pkr(q.loadAmount)})`, `**Net investment:** ${pkr(q.netAmount)}`, `[Key Fact Statement](${q.kfsUrl})`],
      "I acknowledge that I have read the Key Fact Statement.",
      "Generate bill"
    );
  }

  // REDEEM: validate against the fund's balance / SwiftPay limit
  if (screenName === "REDEEM") {
    if (d.component_action === "refresh") return screen("REDEEM", await redeemData(s, d));
    const fail = async (m) => screen("REDEEM", { ...(await redeemData(s, d)), error_message: m });
    const fund = (await api.getExistingFunds(s.mobile, d.folio)).find((f) => f.code === d.fund);
    if (!fund) return fail("Choose a folio and a fund.");
    if (!REASONS[d.reason]) return fail("Choose a reason.");
    const swift = d.type === "swift";
    const full = d.mode === "full";
    const amount = full ? fund.amount : amountOf(d.amount);
    if (amount === null) return fail("Enter the amount in digits, without commas.");
    if (!full && amount < MIN_AMOUNT) return fail(`Minimum redemption is ${pkr(MIN_AMOUNT)}.`);
    if (amount > fund.amount) return fail(`Insufficient balance. Available: ${pkr(fund.amount)}.`);
    if (swift) {
      const lim = (await api.getSwiftLimits(s.mobile, d.folio)).find((l) => l.code === fund.code);
      if (!lim || amount > lim.limit) return fail(`Above the SwiftPay limit of ${pkr(lim ? lim.limit : 0)}.`);
    }
    s.pending = { kind: "redeem", swift, full, folio: d.folio, fund: fund.code, amount, reason: d.reason };
    return review(
      `Review your ${swift ? "SwiftPay" : "normal"} redemption`,
      [`**Folio:** ${d.folio}`, `**Fund:** ${fund.code}`, `**By:** ${full ? "Full redemption" : "Amount"}`, `**Amount:** ${pkr(amount)}`, `**Reason:** ${REASONS[d.reason]}`],
      "Requests after the cut-off time are processed on the next working day.",
      "Send OTP"
    );
  }

  // TRANSFER: fund to fund
  if (screenName === "TRANSFER") {
    if (d.component_action === "refresh") return screen("TRANSFER", await transferData(s, d));
    const fail = async (m) => screen("TRANSFER", { ...(await transferData(s, d)), error_message: m });
    const from = (await api.getExistingFunds(s.mobile, d.folio)).find((f) => f.code === d.from_fund);
    if (!from) return fail("Choose the fund to transfer from.");
    if (!d.to_fund || d.to_fund === "none" || d.to_fund === from.code) return fail("Choose a different fund to transfer to.");
    const full = d.mode === "full";
    const amount = full ? from.amount : amountOf(d.amount);
    if (amount === null) return fail("Enter the amount in digits, without commas.");
    if (!full && amount < MIN_AMOUNT) return fail(`Minimum transfer is ${pkr(MIN_AMOUNT)}.`);
    if (amount > from.amount) return fail(`Insufficient balance. Available: ${pkr(from.amount)}.`);
    const p = { folio: d.folio, from: from.code, to: d.to_fund, amount, full };
    const q = await api.transferQuote(s.mobile, p);
    s.pending = { kind: "transfer", ...p };
    return review(
      "Review your fund transfer",
      [`**Folio:** ${d.folio}`, `**From:** ${from.code}`, `**To:** ${d.to_fund}`, `**Amount:** ${pkr(amount)}`, `**Front-end load:** ${q.loadPercent}% (${pkr(q.loadAmount)})`, `**Net amount:** ${pkr(q.netAmount)}`, `[Key Fact Statement](${q.kfsUrl})`],
      "Amounts are based on the previous day's NAV.",
      "Send OTP"
    );
  }

  // REVIEW: invest -> book the bill; redeem / transfer -> send OTP
  if (screenName === "REVIEW") {
    const p = s.pending;
    if (!p) return { http427: "Please send Hi to start again." };
    if (p.kind === "invest") {
      const bill = await api.investBill(s.mobile, p.folio, p.fund, p.amount);
      if (bill.error) return review("Review your investment", [`**Amount:** ${pkr(p.amount)}`], bill.error, "Generate bill");
      return finish(s, { ...p, ...bill });
    }
    const otp = await api.sendOtp(s.mobile, p.kind === "transfer" ? "fund_to_fund" : p.swift ? "swiftpay" : "redemption");
    s.otpRef = otp.otpRef || null;
    s.otpAttempts = 0;
    return screen("OTP", { sent_to: "Enter the one-time password sent to your registered mobile number and email. It is valid for 3 minutes." });
  }

  // OTP: resend, verify, then book
  if (screenName === "OTP") {
    const p = s.pending;
    const again = (m) => screen("OTP", { sent_to: "Enter the one-time password sent to your registered mobile number and email.", error_message: m });
    if (d.component_action === "resend") {
      const otp = await api.sendOtp(s.mobile, p.kind);
      s.otpRef = otp.otpRef || null;
      return again("A new code has been sent.");
    }
    const check = await api.verifyOtp(s.mobile, d.otp, s.otpRef);
    if (check.expired) return again("This code has expired. Tap Resend code.");
    if (!check.valid) {
      s.otpAttempts += 1;
      if (s.otpAttempts >= 3) {
        s.status = "LOCKED";
        return { http427: "Too many incorrect codes. Send Hi to start again." };
      }
      return again(`Incorrect code. ${3 - s.otpAttempts} attempt(s) left.`);
    }
    // book once: if Confirm is tapped twice, the session is already COMPLETED (427)
    const r = p.kind === "transfer" ? await api.fundToFund(s.mobile, p) : await api.redeem(s.mobile, p);
    if (!r.ok) return again(r.reason || "The request could not be completed.");
    return finish(s, { ...p, ...r });
  }

  // PICK: static information pages
  if (screenName === "PICK") {
    const pages = {
      "company:about": ["About us", "[Visit our website](https://example.com/about)"],
      "company:products": ["Our products", "[See all products](https://example.com/products)"],
      "company:plans": ["Services and plans", "[See services](https://example.com/services)"],
      "fmr:report": ["Fund manager report", "[Open the report](https://example.com/fmr)"],
      "fmr:nav": ["Daily fund prices", "[Open daily prices](https://example.com/nav)"],
    };
    const page = pages[`${d.topic}:${d.choice}`];
    return page ? info(page[0], page[1]) : stay(s, "Please choose an option.");
  }

  // SERVICES: tax certificate (after the Flow closes) or digital status (now)
  if (screenName === "SERVICES") {
    if (!d.folio) return screen("SERVICES", { folios: folioOptions(await api.getFolios(s.mobile)), error_message: "Choose a folio." });
    if (d.request === "tax") return finish(s, { kind: "tax", folio: d.folio, year: d.year });
    const st = await api.getDigitalStatus(s.mobile, d.folio);
    return info(`Digital services for folio ${d.folio}`, `**Debit card:** ${st.debitCard}\n**E-banking:** ${st.eBanking}\n**Tele transaction:** ${st.tele}\n**SMS transaction:** ${st.sms}`);
  }

  // REFER
  if (screenName === "REFER") {
    if (d.status === "employee") {
      const r = await api.registerReferrer(s.mobile, d.sap_code);
      if (!r.ok) return screen("REFER", { error_message: r.reason || "Invalid staff code." });
    }
    return finish(s, { kind: "refer", status: d.status });
  }

  // SUPPORT
  if (screenName === "SUPPORT") {
    const again = async (m) => screen("SUPPORT", { folios: folioOptions(await api.getFolios(s.mobile)), error_message: m });
    if (d.request === "complaint") {
      if (!d.folio || String(d.details || "").trim().length < 10) return again("Choose a folio and describe the complaint.");
      const r = await api.complaint(s.mobile, d.folio, d.details);
      return finish(s, { kind: "complaint", ticket: r.ticket });
    }
    if (d.request === "feedback") {
      if (!String(d.details || "").trim()) return again("Please enter your feedback.");
      await api.feedback(s.mobile, d.details);
      return finish(s, { kind: "feedback" });
    }
    return finish(s, { kind: d.request === "meeting" ? "meeting" : "agent" });
  }

  // LANGUAGE
  if (screenName === "LANGUAGE") return finish(s, { kind: "language", language: d.language });

  return stay(s, "Something went wrong. Please try again.");
}

// =====================================================================
// 6. AFTER THE FLOW CLOSES (from the webhook) — summaries and slow work
// =====================================================================
async function onFlowCompleted(s) {
  const r = s.result;
  const to = s.waId;
  if (!r) return; // an information screen was closed with "Done"
  if (r.kind === "statement") {
    await sendText(to, "Please wait while your statement is generated. It can take up to a minute.");
    const out = await api.emailStatement(s.mobile, r.folio, r.period);
    if (out.pdfUrl) await sendDocument(to, out.pdfUrl, `Statement_${r.folio}.pdf`, "Your account statement");
    await sendText(to, out.ok ? "Your statement has also been sent to your registered email." : "Sorry, the statement could not be generated. Send Hi to try again.");
  } else if (r.kind === "tax") {
    const out = await api.emailTaxCertificate(s.mobile, r.folio, r.year);
    if (out.pdfUrl) await sendDocument(to, out.pdfUrl, `Tax_${r.folio}.pdf`, `Tax certificate ${r.year}`);
    await sendText(to, out.ok ? "Your tax certificate has been sent to your registered email." : "Sorry, the certificate could not be generated. Send Hi to try again.");
  } else if (r.kind === "redeem") {
    await sendText(to, `*Your ${r.swift ? "SwiftPay" : "normal"} redemption request has been received.*\n\nFolio: ${r.folio}\nFund: ${r.fund}\nAmount: ${pkr(r.amount)}\nTransaction ID: ${r.txnId}\n\nNote: CGT may apply as per terms and conditions.`);
  } else if (r.kind === "transfer") {
    await sendText(to, `*Your fund transfer request has been received.*\n\nFolio: ${r.folio}\nFrom: ${r.from}\nTo: ${r.to}\nAmount: ${pkr(r.amount)}\nTransaction ID: ${r.txnId}`);
  } else if (r.kind === "invest") {
    await sendText(to, `*Investment details*\n\nFolio: ${r.folio}\nFund: ${r.fund}\nBill number: ${r.billNumber}\nBank charges: ${pkr(r.charges)}\nTotal payment: ${pkr(r.total)}\n\nPay this bill from your banking app using the bill number.`);
  } else if (r.kind === "complaint") {
    await sendText(to, `Your complaint has been received.${r.ticket ? " Tracking number: " + r.ticket + "." : ""} You will also receive it by email and SMS.`);
  } else if (r.kind === "feedback") {
    await sendText(to, "Thank you for your feedback.");
  } else if (r.kind === "meeting") {
    await api.meeting(s.mobile);
    await sendText(to, "Your meeting request has been forwarded to a sales facilitator.");
  } else if (r.kind === "agent") {
    await api.agent(s.mobile);
  } else if (r.kind === "language") {
    await api.saveLanguage(s.mobile, r.language);
    await sendText(to, r.language === "ur" ? "آپ کی زبان اردو منتخب کر لی گئی ہے۔" : "Your language is set to English.");
  } else if (r.kind === "refer") {
    await sendText(to, r.status === "employee" ? "You are registered as a referrer." : "This service is coming soon for existing investors.");
  }
}

// =====================================================================
// 7. HTTP ROUTES
// =====================================================================
const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf.toString("utf8")) }));

// Meta verifies the webhook URL once
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

// Chat events
app.post("/webhook", async (req, res) => {
  if (!signatureOk(req)) return res.sendStatus(401);
  res.sendStatus(200); // answer Meta first, then do the work
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return; // delivery statuses, flows alerts, etc.

    // A: the customer said something -> start a session and send the Flow
    if (msg.type === "text") {
      const folios = await api.getFolios(toCoreMobile(msg.from));
      if (!folios.length) return sendText(msg.from, "This number is not registered with us.");
      const token = createSession(msg.from);
      return sendFlow(msg.from, token, "Tap below to use our services.");
    }

    // B: the Flow was completed -> summary and slow work
    if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") {
      const { flow_token } = JSON.parse(msg.interactive.nfm_reply.response_json || "{}");
      const s = sessions.get(flow_token);
      if (!s || s.summarySent) return; // unknown, or a repeated delivery
      s.summarySent = true;
      saveSession(s);
      await onFlowCompleted(s);
    }
  } catch (e) {
    console.error("webhook error", e);
  }
});

// The Flow endpoint
app.post("/flow-endpoint", async (req, res) => {
  if (!signatureOk(req)) return res.status(432).send();

  let request, aesKey, iv;
  try {
    ({ request, aesKey, iv } = decryptRequest(req.body));
  } catch (e) {
    return res.status(421).send(); // WhatsApp re-fetches the public key and retries
  }
  const reply = (obj) => res.type("text/plain").send(encryptResponse(obj, aesKey, iv));
  // Screen replies carry the data API version, as in Meta's examples.
  const replyScreen = (obj) => reply({ version: "3.0", ...obj });
  const { action, screen: screenName, data = {}, flow_token } = request;

  if (action === "ping") return reply({ data: { status: "active" } });
  if (data.error) {
    console.error("WhatsApp reported a bad reply:", data);
    return reply({ data: { acknowledged: true } });
  }

  // flow_token -> session (and phone number)
  let s = getSession(flow_token);
  if (!s && TEST_PHONE && action === "INIT") s = getSession(createSession(TEST_PHONE, flow_token));
  if (!s) return res.status(427).send(encryptResponse({ error_msg: "This session has expired. Send Hi to start again." }, aesKey, iv));
  if (s.status === "COMPLETED") return res.status(427).send(encryptResponse({ error_msg: "This request has already been submitted." }, aesKey, iv));
  if (s.status === "LOCKED") return res.status(427).send(encryptResponse({ error_msg: "Too many incorrect codes. Send Hi to start again." }, aesKey, iv));

  try {
    const next = action === "INIT" || action === "BACK" ? menu(s) : await handleScreen(s, screenName, data);
    if (next.screen && next.screen !== "SUCCESS") s.lastScreen = { screen: next.screen, data: { ...next.data, error_message: undefined } };
    saveSession(s);
    if (next.http427) return res.status(427).send(encryptResponse({ error_msg: next.http427 }, aesKey, iv));
    return replyScreen(next);
  } catch (e) {
    console.error(`screen ${screenName} failed:`, e.message);
    return replyScreen(stay(s, "The service is temporarily unavailable. Please try again."));
  }
});
app.get("/",async(req,res) => {
  return res.status(200).send({message:"deployment on render worked !"})
});

app.listen(Number(PORT), () => {
  console.log(`Listening on ${PORT}: /webhook and /flow-endpoint`);
  console.log(USE_MOCK ? `Using MOCK APIs (CORE_BASE_URL not set). Test OTP: ${MOCK_OTP}` : `Using real APIs at ${CORE_BASE_URL}`);
  if (TEST_PHONE) console.log(`TEST_PHONE set: unknown flow_tokens get a session for ${TEST_PHONE} (testing only)`);
});
