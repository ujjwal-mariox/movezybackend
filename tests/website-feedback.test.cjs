const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { load, categories, harness, invoke, beginInvoke } = require('./helpers/website-feedback-harness.cjs');
const valid = { name: 'QA Visitor', email: 'qa@example.test', message: 'Please help with this booking.', category: 'NEW_BOOKING' };

test('website, admin and API use the same eight enquiry categories', () => {
  const shared = load('../admin/movezy-admin/shared/contact-categories.ts');
  assert.deepEqual(JSON.parse(JSON.stringify(categories.CONTACT_CATEGORIES)), JSON.parse(JSON.stringify(shared.CONTACT_CATEGORIES)));
  assert.equal(Object.keys(shared.CONTACT_CATEGORIES).length, 8);
});
for (const category of Object.keys(categories.CONTACT_CATEGORIES)) test('contact receipt persists category ' + category, async () => {
  const h = harness();
  const res = await invoke(h.contact.submitContact, { ...valid, category });
  assert.equal(res.statusCode, 200); assert.equal(res.headersSent, true); assert.equal(res.body.success, true);
  assert.equal(res.body.data.received, true); assert.equal(res.body.data.category, category);
  assert.equal(res.body.data.reference, h.state.rows[0]._id); assert.equal(h.state.rows[0].category, category);
  assert.equal(res.body.data.acknowledged, false); assert.equal(h.state.mail.length, 0);
});
test('older contact form subject maps to a useful category', async () => {
  const h = harness(); const res = await invoke(h.contact.submitContact, { ...valid, category: undefined, subject: 'Business enquiry' });
  assert.equal(res.body.data.category, 'BUSINESS_ENQUIRY');
});
for (const value of ['UNKNOWN', { OTHER: true }, '__proto__']) test('invalid category is rejected before storage: ' + JSON.stringify(value), async () => {
  const h = harness(); const res = await invoke(h.contact.submitContact, { ...valid, category: value });
  assert.equal(res.statusCode, 400); assert.equal(h.state.rows.length, 0);
});
for (const change of [{ name: 'x' }, { email: 'bad' }, { message: 'short' }, { message: 'x'.repeat(4001) }, { name: {} }, { phone: 'letters-only' }, { phone: '       1' }]) test('invalid input never creates an enquiry: ' + Object.keys(change)[0] + JSON.stringify(change).slice(0, 30), async () => {
  const h = harness(); const res = await invoke(h.contact.submitContact, { ...valid, ...change });
  assert.equal(res.statusCode, 400); assert.equal(h.state.rows.length, 0);
});
test('optional formatted phone number is normalized without accepting letters', async () => {
  const h = harness(); await invoke(h.contact.submitContact, { ...valid, phone: '+91 90000-00000' });
  assert.equal(h.state.rows[0].phone, '+919000000000');
});
for (const fail of ['failInbox', 'failMail']) test('stored enquiry is acknowledged even when ' + fail, async () => {
  const h = harness({ smtp: true, [fail]: true }); const res = await invoke(h.contact.submitContact, valid);
  assert.equal(res.body.data.received, true); assert.equal(h.state.rows.length, 1); assert.equal(res.body.data.acknowledged, false);
});
test('storage failure cannot return a successful receipt', async () => {
  const h = harness({ failStore: true }); const res = await invoke(h.contact.submitContact, valid);
  assert.equal(res.statusCode, 400); assert.equal(res.body.code, 0); assert.equal(res.body.data.received, undefined);
});
test('delivered acknowledgement and category are recorded; email HTML escapes visitor input', async () => {
  const h = harness({ smtp: true }); const res = await invoke(h.contact.submitContact, { ...valid, name: '<img src=x>', message: '<script>alert(1)</script>' });
  assert.equal(res.body.data.acknowledged, false); // Delivery occurs after the storage receipt.
  assert.equal(h.state.rows[0].emailedToTeam, true);
  assert.equal(h.state.rows[0].acknowledged, true);
  assert.match(h.state.mail[0].subject, /New Booking/); assert.match(h.state.mail[0].html, /&lt;script&gt;/);
  assert.doesNotMatch(h.state.mail[0].html, /<script>/);
});
test('slow SMTP cannot delay the durable receipt or invite duplicate retries', async () => {
  let release; const mailGate = new Promise(resolve => { release = resolve; });
  const h = harness({ smtp: true, mailGate }); const pending = beginInvoke(h.contact.submitContact, valid);
  await new Promise(setImmediate);
  assert.equal(pending.res.headersSent, true); assert.equal(pending.res.body.data.received, true);
  assert.equal(h.state.rows.length, 1); assert.equal(pending.res.body.data.acknowledged, false);
  release(); await pending.completion; assert.equal(h.state.rows[0].acknowledged, true);
});
test('honeypot returns a receipt without storage or emails', async () => {
  const h = harness({ smtp: true }); const res = await invoke(h.contact.submitContact, { website: 'bot.example' });
  assert.equal(res.body.data.received, true); assert.equal(h.state.rows.length, 0); assert.equal(h.state.mail.length, 0);
});
test('admin list filters enquiries and excludes request metadata', async () => {
  const h = harness({ rows: [{ ...valid, _id: '1'.repeat(24), status: 'NEW' }, { ...valid, _id: '2'.repeat(24), category: 'OTHER', status: 'CLOSED' }] });
  const res = await invoke(h.admin.listContactMessages, {}, { category: 'NEW_BOOKING', status: 'NEW' });
  assert.equal(res.headersSent, true); assert.equal(res.body.data.messages.length, 1); assert.equal(res.body.data.pagination.total, 1);
  assert.equal(h.state.projections[0], '-ip -userAgent');
});
test('legacy enquiries without categories remain visible under Other', async () => {
  const h = harness({ rows: [{ _id: '1'.repeat(24), status: 'NEW' }] });
  const res = await invoke(h.admin.listContactMessages, {}, { category: 'OTHER' });
  assert.equal(res.body.data.messages.length, 1);
});
for (const query of [{ limit: '51' }, { page: '0' }, { page: '1.2' }, { category: 'INVALID' }, { status: 'PAID' }]) test('invalid admin query rejected: ' + JSON.stringify(query), async () => {
  const h = harness(); const res = await invoke(h.admin.listContactMessages, {}, query); assert.equal(res.statusCode, 400);
});
test('admin status changes use valid audit enums without sending messages', async () => {
  const h = harness({ rows: [{ ...valid, _id: '1'.repeat(24), status: 'NEW' }] });
  const res = await invoke(h.admin.updateContactMessageStatus, { status: 'REPLIED' }, {}, { id: '1'.repeat(24) });
  assert.equal(res.body.data.message.status, 'REPLIED'); assert.equal(h.state.mail.length, 0);
  const audit = load('src/models/audit-log.model.ts', { mongoose }).AuditLog;
  assert.ok(audit.schema.path('action').enumValues.includes(h.state.audits[0].action));
  assert.ok(audit.schema.path('module').enumValues.includes(h.state.audits[0].module));
  assert.equal(h.state.audits[0].changes[0].oldValue, 'NEW');
  assert.equal(h.state.audits[0].changes[0].newValue, 'REPLIED');
});
test('admin pagination returns a stable slice and complete total', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ ...valid, _id: String(index).padStart(24, '0'), createdAt: '2026-10-07', status: 'NEW', ip: 'private', userAgent: 'private' }));
  const h = harness({ rows }); const res = await invoke(h.admin.listContactMessages, {}, { page: '2', limit: '20' });
  assert.equal(res.body.data.pagination.total, 25); assert.equal(res.body.data.pagination.pages, 2);
  assert.equal(res.body.data.messages.length, 5); assert.equal(res.body.data.messages[0]._id, String(4).padStart(24, '0'));
  assert.equal(res.body.data.messages[0].ip, undefined); assert.equal(res.body.data.messages[0].userAgent, undefined);
});
test('missing and invalid enquiry identifiers never update a record', async () => {
  const h = harness();
  assert.equal((await invoke(h.admin.updateContactMessageStatus, { status: 'CLOSED' }, {}, { id: 'invalid' })).statusCode, 400);
  assert.equal((await invoke(h.admin.updateContactMessageStatus, { status: 'CLOSED' }, {}, { id: '1'.repeat(24) })).statusCode, 404);
});
test('support viewers cannot mark enquiries without resolve permission', () => {
  const auth = load('src/middlewares/admin-auth.middleware.ts', { jsonwebtoken: {}, '../config': {}, '../models/admin.model': {}, '../models/role.model': {} }).default();
  const guard = auth.requirePermission('support:resolve');
  let next = false; const res = { status(code) { this.code = code; return this; }, json() {} };
  guard({ admin: { permissions: ['support:view'] } }, res, () => { next = true; });
  assert.equal(res.code, 403); assert.equal(next, false);
  guard({ admin: { permissions: ['support:resolve'] } }, res, () => { next = true; }); assert.equal(next, true);
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/admin.routes.ts'), 'utf8');
  assert.match(routes, /get\("\/contact-messages", verifyAdminToken, requirePermission\(PERMISSIONS.SUPPORT_VIEW\)/);
  assert.match(routes, /put\("\/contact-messages\/:id\/status", verifyAdminToken, requirePermission\(PERMISSIONS.SUPPORT_RESOLVE\)/);
});
test('policy stubs, drafts and invalid publication dates cannot replace published content', () => {
  const { isPublishedPolicy } = load('../admin/movezy-admin/site/src/content/policy-content.ts');
  assert.equal(isPublishedPolicy({ content: '<h1>Privacy</h1><p>We value privacy.</p>' }), false);
  assert.equal(isPublishedPolicy({ content: 'Text '.repeat(150) }), false);
  assert.equal(isPublishedPolicy({ content: 'Text '.repeat(150), publishedAt: 'invalid' }), false);
  assert.equal(isPublishedPolicy({ content: 'Text '.repeat(150), publishedAt: '2026-10-07' }), true);
});
