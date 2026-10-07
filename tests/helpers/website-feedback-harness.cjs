const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '../..');
function load(relative, modules = {}, globals = {}) {
  const source = fs.readFileSync(path.resolve(root, relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, module: { exports }, require: name => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw Error('Unexpected dependency: ' + name);
  }, Date, URL, Buffer, console: { log() {}, error() {} }, ...globals }, { filename: relative });
  return exports;
}
const categories = load('src/services/contact-category.service.ts');
const response = load('src/middlewares/response.middleware.ts', { '../utils/messages': () => ({}) }).default;
const wrap = load('src/middlewares/error-handler.middleware.ts', { './response.middleware': response }).default;
function harness(options = {}) {
  const state = { rows: options.rows || [], mail: [], audits: [], filters: [], projections: [] };
  const query = fn => {
    const settings = {};
    const q = { then: (yes, no) => Promise.resolve().then(fn).then(value => {
      let result = structuredClone(value);
      if (Array.isArray(result)) {
        if (settings.sort) result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b._id).localeCompare(String(a._id)));
        result = result.slice(settings.skip || 0, settings.limit ? (settings.skip || 0) + settings.limit : undefined);
      }
      if (settings.select?.startsWith('-')) for (const row of Array.isArray(result) ? result : [result]) {
        if (row) for (const field of settings.select.split(' ')) delete row[field.slice(1)];
      }
      return result;
    }).then(yes, no) };
    for (const method of ['select', 'sort', 'skip', 'limit', 'lean']) q[method] = value => { settings[method] = value; if (method === 'select') state.projections.push(value); return q; };
    return q;
  };
  const matches = (row, filter) => Object.entries(filter).every(([key, wanted]) => {
    if (key === '$or') return wanted.some(item => matches(row, item));
    if (wanted && typeof wanted === 'object' && '$exists' in wanted) return (row[key] !== undefined) === wanted.$exists;
    return wanted == null ? row[key] == null : row[key] === wanted;
  });
  const model = {
    create: async values => { if (options.failStore) throw Error('Database unavailable'); const row = { ...values, _id: String(state.rows.length + 1).padStart(24, '0'), status: 'NEW', createdAt: new Date().toISOString() }; state.rows.push(row); return row; },
    updateOne: async (filter, update) => Object.assign(state.rows.find(row => row._id === String(filter._id)), update.$set),
    find: filter => { state.filters.push(filter); return query(() => state.rows.filter(row => matches(row, filter))); },
    countDocuments: async filter => state.rows.filter(row => matches(row, filter)).length,
    findById: id => query(() => state.rows.find(row => row._id === id) || null),
    findByIdAndUpdate: (id, update) => query(() => { const row = state.rows.find(row => row._id === id); return row ? Object.assign(row, update.$set) : null; }),
  };
  const contact = load('src/controllers/contact.controller.ts', {
    '../models/contact-message.model': model,
    '../models/app-config.model': { AppConfig: { find: () => query(() => { if (options.failInbox) throw Error('Config unavailable'); return [{ key: 'SUPPORT_EMAIL', value: 'team@example.test' }]; }) } },
    '../services/email.service': { isEmailConfigured: () => !!options.smtp, sendEmail: async input => { state.mail.push(input); if (options.mailGate) await options.mailGate; if (options.failMail) throw Error('SMTP unavailable'); return true; } },
    '../config': { email: { from: '' } },
    '../services/contact-category.service': categories,
  });
  const admin = load('src/controllers/admin/contact-message.controller.ts', {
    mongoose,
    '../../models/contact-message.model': model,
    '../../services/contact-category.service': categories,
    './audit-log.controller': { auditFromRequest: async (_req, entry) => state.audits.push(entry) },
  });
  return { state, contact, admin };
}
function beginInvoke(handler, body = {}, query = {}, params = {}) {
  const req = { body, query, params, headers: {}, ip: '127.0.0.1' };
  const res = { locals: {}, statusCode: 200, headersSent: false, status(code) { this.statusCode = code; return this; }, json(value) { this.body = JSON.parse(JSON.stringify(value)); this.headersSent = true; return this; } };
  const completion = wrap(handler)(req, res, () => response(req, res));
  return { res, completion };
}
async function invoke(...args) { const { res, completion } = beginInvoke(...args); await completion; return res; }
module.exports = { load, categories, wrap, harness, invoke, beginInvoke, response };
