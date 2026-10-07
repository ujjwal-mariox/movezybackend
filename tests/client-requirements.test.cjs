const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Types } = require('mongoose');

// Load real application code against isolated adapters. These tests never
// connect to Mongo, Redis, telephony, storage, or the deployed application.
const id = n => n.toString(16).padStart(24, '0');
function load(relative, modules) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  const context = { exports, module: { exports }, require: name => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw Error('Unexpected dependency: ' + name);
  }, Date, Buffer, URLSearchParams, AbortSignal, process: { env: {}, cwd: () => path.join(__dirname, '..') },
    console: { log() {}, warn() {}, error() {} }, setTimeout() {}, clearTimeout() {} };
  vm.runInNewContext(js, context, { filename: relative });
  return exports;
}
function match(row, filter) {
  return Object.entries(filter).every(([key, wanted]) => {
    const value = row[key];
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Types.ObjectId) && !(wanted instanceof Date)) {
      if ('$regex' in wanted) return new RegExp(wanted.$regex, wanted.$options || '').test(String(value));
      if ('$in' in wanted) return wanted.$in.some(v => String(v) === String(value));
      if ('$ne' in wanted) return String(value) !== String(wanted.$ne);
      if ('$gt' in wanted) return new Date(value) > new Date(wanted.$gt);
      if ('$lt' in wanted) return new Date(value) < new Date(wanted.$lt);
      if ('$lte' in wanted) return new Date(value) <= new Date(wanted.$lte);
    }
    return wanted == null ? value == null : String(value) === String(wanted);
  });
}
function harness() {
  const state = {
    bookings: [{ _id: id(1), vehicleTypeId: id(3), driverId: null, status: 'SEARCHING', userId: id(8) }],
    drivers: [{ _id: id(2), isOnline: true, status: 'approved', fullName: 'Partner' }],
    dispatchVehicles: [{ _id: id(4), driverId: id(2), vehicleTypeId: id(3), isActive: true, isDeleted: false, registrationNumber: 'KA01AB1234' }],
    vehicles: [{ _id: id(5), driverId: id(2), vehicleNumber: 'KA01AB1234', vehicleTypeId: id(3), onboardingFeePaid: true, isPrimary: true, verificationStatus: 'approved', isDeleted: false }],
    offers: [{ bookingId: id(1), driverId: id(2), response: 'PENDING', expiresAt: new Date(Date.now() + 60000) }],
  };
  let failAssignment = false;
  let tail = Promise.resolve();
  const query = run => {
    const q = { then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject) };
    for (const key of ['select', 'lean', 'populate', 'session', 'limit', 'sort']) q[key] = () => q;
    return q;
  };
  const model = name => ({
    find: filter => query(() => state[name].filter(row => match(row, filter))),
    findOne: filter => query(() => {
      const row = state[name].find(row => match(row, filter)) ?? null;
      if (row && name === 'vehicles' && !row.save) Object.defineProperties(row, {
        save: { value: async () => row }, toObject: { value: () => structuredClone(row) },
      });
      return row;
    }),
    findById: value => query(() => state[name].find(row => String(row._id) === String(value)) ?? null),
    exists: filter => query(() => state[name].find(row => match(row, filter)) ? { _id: id(20) } : null),
    findOneAndUpdate: (filter, update, options = {}) => query(() => {
      if (name === 'bookings' && update.$set?.status === 'ASSIGNED' && failAssignment) return null;
      let row = state[name].find(row => match(row, filter));
      if (!row && options.upsert) {
        row = { ...filter, ...update.$setOnInsert };
        state[name].push(row);
      }
      if (row) Object.assign(row, update.$set);
      return row ?? null;
    }),
    updateOne: (filter, update) => query(() => {
      const row = state[name].find(row => match(row, filter));
      if (row) Object.assign(row, update.$set);
      return { modifiedCount: row ? 1 : 0 };
    }),
    updateMany: (filter, update) => query(() => {
      const rows = state[name].filter(row => match(row, filter));
      rows.forEach(row => Object.assign(row, update.$set));
      return { modifiedCount: rows.length };
    }),
  });
  const mongo = { Types, connection: { transaction: fn => {
    // Model serializable Mongo transactions, including abort and retry isolation.
    const result = tail.then(async () => {
      const before = JSON.parse(JSON.stringify(state));
      try { return await fn({}); }
      catch (error) { Object.assign(state, before); throw error; }
    });
    tail = result.catch(() => {});
    return result;
  } } };
  const keys = new Map();
  const sets = new Map();
  const queues = new Map();
  const hashes = new Map();
  const emitted = [];
  const redis = {
    geoSearchWith: async () => state.drivers.map((d, n) => ({ member: d._id, distance: d.distance ?? n + 1,
      coordinates: { latitude: 12, longitude: 77 } })),
    sMembers: async key => [...(sets.get(key) ?? [])],
    sIsMember: async (key, member) => sets.get(key)?.has(member) ?? false,
    sAdd: async (key, member) => { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(member); },
    get: async key => keys.get(key) ?? null,
    set: async (key, value, options = {}) => {
      if (options.NX && keys.has(key)) return null;
      keys.set(key, value); return 'OK';
    },
    setEx: async (key, _, value) => { keys.set(key, value); },
    del: async key => { for (const k of Array.isArray(key) ? key : [key]) { keys.delete(k); sets.delete(k); queues.delete(k); hashes.delete(k); } },
    hDel: async (key, field) => hashes.get(key)?.delete(field),
    hSet: async (key, field, value) => { if (!hashes.has(key)) hashes.set(key, new Map()); hashes.get(key).set(field, value); },
    lPop: async key => queues.get(key)?.shift() ?? null,
    lPush: async (key, value) => { if (!queues.has(key)) queues.set(key, []); queues.get(key).unshift(value); },
    rPush: async (key, values) => { if (!queues.has(key)) queues.set(key, []); queues.get(key).push(...values); },
    lLen: async key => queues.get(key)?.length ?? 0,
    expire: async () => {},
  };
  const service = load('src/services/booking-dispatch.service.ts', {
    mongoose: mongo,
    '../models/booking.model': model('bookings'), '../models/driver.model': model('drivers'),
    '../models/driver-vehicle.model': model('dispatchVehicles'), '../models/vehicle.model': model('vehicles'),
    '../models/dispatch-offer.model': model('offers'),
    '../utils/redis.util': { getRedisClient: () => redis, cache: { get: async key => keys.get(key) ?? null } },
    '../utils/socket.util': { emitToUser: (driverId, event, payload) => emitted.push({ driverId, event, payload }), emitToBooking() {}, getIO: () => { throw Error('No socket'); } },
    '../models/app-config.model': { AppConfig: { find: () => query(() => [{ key: 'DISPATCH_PARALLEL_OFFERS', value: 10 }]) } },
    '../utils/mqtt.util': { sendBookingAcceptedBroadcast: async () => {} },
    './notification.service': {}, './call-masking.service': { presentPhone: () => 'XXXXXX1234' },
    './vehicle-lifecycle.service': { normalizeVehicleNumber: n => String(n).toUpperCase().replace(/[^A-Z0-9]/g, '') },
    './training-gate.service': { getTrainingGateStatus: async () => ({ required: false, complete: true }), hasMandatoryTraining: async () => false },
  });
  const lifecycle = load('src/services/vehicle-lifecycle.service.ts', {
    mongoose: mongo,
    '../models/booking.model': model('bookings'), '../models/driver.model': model('drivers'),
    '../models/driver-vehicle.model': model('dispatchVehicles'), '../models/vehicle.model': model('vehicles'),
    '../models/vehicle-type.model': {}, '../models/master-data.model': {},
  });
  return { state, service, lifecycle, failAssignment: () => { failAssignment = true; }, redis, emitted };
}

test('only a valid current offer can assign the matching approved selected vehicle', async () => {
  const h = harness();
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(2))).success, true);
  assert.equal(h.state.bookings[0].status, 'ASSIGNED');
  assert.equal(String(h.state.bookings[0].vehicleId), id(5));
  assert.equal(h.state.offers[0].response, 'ACCEPTED');
  assert.equal(String(h.state.drivers[0].currentBookingId), id(1));
});
for (const [label, mutate] of [
  ['unoffered', s => { s.offers = []; }],
  ['expired', s => { s.offers[0].expiresAt = new Date(Date.now() - 1); }],
  ['declined', s => { s.offers[0].response = 'SKIPPED'; }],
  ['other driver offer', s => { s.offers[0].driverId = id(9); }],
  ['wrong vehicle category', s => { s.dispatchVehicles[0].vehicleTypeId = id(9); }],
  ['offline', s => { s.drivers[0].isOnline = false; }],
  ['vehicle awaiting reapproval', s => { s.vehicles[0].verificationStatus = 'pending'; }],
  ['inactive vehicle', s => { s.dispatchVehicles[0].isActive = false; }],
  ['busy driver', s => { s.bookings.push({ _id: id(6), driverId: id(2), status: 'IN_PROGRESS' }); }],
]) test(label + ' cannot accept or appear in dispatch offers', async () => {
  const h = harness(); mutate(h.state);
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(2))).success, false);
  assert.equal(h.state.bookings[0].status, 'SEARCHING');
  assert.equal(h.state.bookings[0].driverId, null);
  // getDriverOfferFilter uses the dispatch row; reapproval synchronizes it inactive.
  if (label !== 'vehicle awaiting reapproval' && label !== 'wrong vehicle category') {
    const filter = await h.service.getDriverOfferFilter(id(2));
    assert.equal(h.state.bookings.filter(row => match(row, filter)).length, 0);
  }
});
test('failed booking assignment rolls back the claimed offer and driver', async () => {
  const h = harness(); h.failAssignment();
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(2))).success, false);
  assert.equal(h.state.offers[0].response, 'PENDING');
  assert.equal(h.state.drivers[0].currentBookingId, undefined);
});
test('a driver cannot accept two different bookings concurrently', async () => {
  const h = harness();
  h.state.bookings.push({ ...h.state.bookings[0], _id: id(6) });
  h.state.offers.push({ ...h.state.offers[0], bookingId: id(6) });
  const results = await Promise.all([h.service.handleDriverAcceptance(id(1), id(2)), h.service.handleDriverAcceptance(id(6), id(2))]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(h.state.bookings.filter(b => b.status === 'ASSIGNED').length, 1);
});

function addNearestCandidates(h) {
  h.state.offers = [];
  h.state.bookings[0].pickup = { lat: 12, lng: 77, address: 'Pickup' };
  h.state.drivers[0].distance = 2;
  h.state.drivers.push({ _id: id(9), distance: 1, status: 'approved', isOnline: true },
    { _id: id(11), distance: 5, status: 'approved', isOnline: true });
  h.state.dispatchVehicles.push({ _id: id(10), driverId: id(9), vehicleTypeId: id(15), isActive: true, isDeleted: false },
    { _id: id(12), driverId: id(11), vehicleTypeId: id(3), isActive: true, isDeleted: false });
}

test('nearest eligible driver receives the only offer; decline advances to the next nearest', async () => {
  const h = harness(); addNearestCandidates(h);
  const drivers = await h.service.findNearbyDrivers(12, 77, id(3));
  assert.deepEqual(Array.from(drivers, d => d.driverId), [id(2), id(11)]);
  assert.equal((await h.service.dispatchSettings()).parallelOffers, 1);
  assert.deepEqual(Array.from(await h.service.offerNext(id(1))), [id(2)]);
  assert.equal(h.state.offers.filter(o => o.response === 'PENDING').length, 1);
  assert.equal((await h.service.handleDriverRejection(id(1), id(2))).success, true);
  assert.equal(h.state.offers.find(o => o.driverId === id(2)).response, 'SKIPPED');
  assert.equal(h.state.offers.filter(o => o.response === 'PENDING').length, 1);
  assert.equal(h.state.offers.find(o => o.response === 'PENDING').driverId, id(11));
  assert.deepEqual(h.emitted.filter(e => e.event === 'booking:request').map(e => e.driverId), [id(2), id(11)]);
});

test('admin sweep and manual action offer the nearest driver without bypassing acceptance', async () => {
  const h = harness(); addNearestCandidates(h);
  const q = value => {
    const result = { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
    for (const key of ['sort', 'limit']) result[key] = () => result;
    return result;
  };
  const Booking = { find: filter => q(h.state.bookings.filter(b => match(b, filter))),
    findById: bid => q(h.state.bookings.find(b => b._id === bid)) };
  const sweep = load('src/services/auto-assign.service.ts', { mongoose: { Types },
    '../models/booking.model': Booking, './booking-dispatch.service': h.service });
  const offered = await sweep.runAutoAssignSweep();
  assert.equal(offered.offered, 1);
  assert.equal(offered.assigned, 0);
  assert.equal(h.state.bookings[0].status, 'SEARCHING');
  assert.equal(h.state.offers[0].driverId, id(2));
  const repeated = await sweep.runAutoAssignSweep();
  assert.equal(repeated.offered, 0);
  assert.equal(repeated.awaitingResponse, 1);
  assert.equal(h.state.offers.filter(o => o.response === 'PENDING').length, 1);

  const controller = load('src/controllers/admin/booking.controller.ts', {
    mongoose: { Types }, '../../models/booking.model': Booking, '../../models/Users': {}, '../../models/driver.model': {},
    '../../utils/socket.util': {}, '../../services/notification.service': {}, '../../utils/mqtt.util': {},
    '../../services/booking-dispatch.service': h.service, '../../services/auto-assign.service': sweep,
    '../../services/payment.service': {}, '../../services/enterprise.service': {},
  });
  const res = { locals: {}, status: () => res, json: body => { throw Error(JSON.stringify(body)); } };
  await controller.assignDriver({ params: { id: id(1) }, body: { driverId: id(9) } }, res);
  assert.equal(res.locals.data.offeredDriverId, id(2));
  assert.equal(res.locals.data.awaitingResponse, true);
  assert.equal(h.state.bookings[0].driverId, null);
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(9))).success, false);
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(2))).success, true);
});

test('retry dispatch cannot reopen a cancelled or assigned booking', async () => {
  for (const status of ['CANCELLED', 'ASSIGNED', 'COMPLETED']) {
    const h = harness(); addNearestCandidates(h);
    h.state.bookings[0].status = status;
    assert.equal((await h.service.dispatchBookingToDrivers(id(1))).success, false);
    assert.equal(h.state.bookings[0].status, status);
    assert.equal(h.state.offers.length, 0);
  }
});

test('offer expiry advances to the next nearest and persisted offers recover after cache loss', async () => {
  const h = harness(); addNearestCandidates(h);
  await h.service.offerNext(id(1));
  const recovered = await h.service.getDriverOfferPayloads(id(2));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].bookingId, id(1));
  assert.equal(typeof recovered[0].expiresAt, 'number');
  h.state.offers[0].expiresAt = new Date(Date.now() - 5000);
  assert.equal(await h.service.sweepExpiredOffers(), 1);
  assert.equal(h.state.offers[0].response, 'EXPIRED');
  assert.equal(h.state.offers.find(o => o.response === 'PENDING').driverId, id(11));
});
test('a post-commit Redis failure does not report successful assignment as a failure', async () => {
  const h = harness(); h.redis.sMembers = async () => { throw Error('Redis unavailable'); };
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(2))).success, true);
  assert.equal(h.state.bookings[0].status, 'ASSIGNED');
});
test('an outsider or expired offer cannot decline and advance dispatch', async () => {
  const h = harness(); h.state.offers[0].expiresAt = new Date(Date.now() - 1);
  assert.equal((await h.service.handleDriverRejection(id(1), id(2))).success, false);
  assert.equal(h.state.offers[0].response, 'PENDING');
});

test('registration conflicts detect the same normalized number for any partner and permit removed vehicles', async () => {
  const h = harness();
  assert.equal(String((await h.lifecycle.findVehicleConflict('ka 01-ab1234', id(2))).own._id), id(5));
  assert.equal(String((await h.lifecycle.findVehicleConflict('KA01AB1234', id(9))).other._id), id(5));
  h.state.vehicles[0].isDeleted = true;
  assert.equal((await h.lifecycle.findVehicleConflict('KA01AB1234', id(9))).own, undefined);
  assert.equal((await h.lifecycle.findVehicleConflict('KA01AB1234', id(9))).other, undefined);
});

test('invoice PDF embeds the shipped Movezy logo and prints the Movezy brand name', async () => {
  const PDFDocument = require('pdfkit');
  const labels = [];
  class TracedPdf extends PDFDocument {
    text(label, ...args) { labels.push(label); return super.text(label, ...args); }
  }
  const renderer = load('src/services/invoice-pdf.service.ts', { pdfkit: TracedPdf, fs, path });
  const buffer = await renderer.renderInvoicePdf({ invoice: {
    invoiceNumber: 'MVZ-TEST-001', generatedAt: new Date(), companyGstin: 'TEST',
    baseFare: 100, subtotal: 100, grandTotal: 100, status: 'PAID',
  }, booking: { userId: { fullName: 'Test Customer' }, pickup: { address: 'Test Pickup' }, drop: { address: 'Test Drop' } } });
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.match(buffer.toString('latin1'), /\/Subtype \/Image/);
  assert.equal(labels.includes('Movezy'), true);
});

test('fuel edits update the same paid vehicle and take it off dispatch pending reapproval', async () => {
  const h = harness();
  const fuel = h.lifecycle.normalizeFuelType('Electronic');
  assert.equal(fuel, 'Electric');
  assert.equal(await h.lifecycle.validateVehicleAttributes('2W', 'Scooter', fuel), null);
  assert.equal(await h.lifecycle.validateVehicleAttributes('2W', 'Bike', 'Petrol'), null);
  assert.equal(await h.lifecycle.validateVehicleAttributes('2W', 'Open', 'Petrol'), 'invalid_body_type_for_two_wheeler');
  assert.equal(await h.lifecycle.validateVehicleAttributes('2W', 'Bike', 'Diesel'), 'invalid_fuel_type_for_two_wheeler');
  const result = await h.lifecycle.editPartnerVehicle(id(2), id(5), { fuelType: fuel });
  assert.equal(result.ok, true);
  assert.equal(h.state.vehicles.length, 1);
  assert.equal(String(h.state.vehicles[0]._id), id(5));
  assert.equal(h.state.vehicles[0].onboardingFeePaid, true);
  assert.equal(h.state.vehicles[0].verificationStatus, 'pending');
  assert.equal(h.state.dispatchVehicles[0].isActive, false);
  assert.equal((await h.service.handleDriverAcceptance(id(1), id(2))).success, false);
});

test('vehicle edits and activation are refused during a trip', async () => {
  const h = harness(); h.state.bookings.push({ _id: id(6), driverId: id(2), status: 'IN_PROGRESS' });
  assert.equal((await h.lifecycle.editPartnerVehicle(id(2), id(5), { fuelType: 'Electric' })).ok, false);
  assert.equal(h.state.vehicles[0].verificationStatus, 'approved');
  assert.equal((await h.lifecycle.setActiveVehicle(id(2), id(5))).ok, false);
});

test('concurrent vehicle selections leave exactly one primary and one dispatch vehicle', async () => {
  const h = harness();
  h.state.vehicles.push({ ...h.state.vehicles[0], _id: id(6), vehicleNumber: 'KA01AB5678', isPrimary: false });
  h.state.dispatchVehicles.push({ ...h.state.dispatchVehicles[0], _id: id(7), registrationNumber: 'KA01AB5678', isActive: false });
  const result = await Promise.all([h.lifecycle.setActiveVehicle(id(2), id(5)), h.lifecycle.setActiveVehicle(id(2), id(6))]);
  assert.equal(result.every(r => r.ok), true);
  assert.equal(h.state.vehicles.filter(v => v.isPrimary).length, 1);
  assert.equal(h.state.dispatchVehicles.filter(v => v.isActive).length, 1);
  assert.equal(h.state.dispatchVehicles.find(v => v.isActive).registrationNumber,
    h.state.vehicles.find(v => v.isPrimary).vehicleNumber);
});

test('concurrent admin approvals do not activate two vehicles for one partner', async () => {
  const h = harness();
  h.state.vehicles[0].isPrimary = false;
  h.state.dispatchVehicles[0].isActive = false;
  h.state.vehicles.push({ ...h.state.vehicles[0], _id: id(6), vehicleNumber: 'KA01AB5678' });
  h.state.dispatchVehicles.push({ ...h.state.dispatchVehicles[0], _id: id(7), registrationNumber: 'KA01AB5678' });
  await Promise.all(h.state.vehicles.map(v => h.lifecycle.ensurePrimaryAfterApproval(v)));
  assert.equal(h.state.vehicles.filter(v => v.isPrimary).length, 1);
  assert.equal(h.state.dispatchVehicles.filter(v => v.isActive).length, 1);
  assert.equal(h.state.dispatchVehicles.find(v => v.isActive).registrationNumber,
    h.state.vehicles.find(v => v.isPrimary).vehicleNumber);
});

test('privacy is enforced when a proxy provider is absent', async () => {
  const logs = [];
  const service = load('src/services/call-masking.service.ts', {
    mongoose: { Types }, '../config': { sms: {} },
    '../models/call-log.model': { countDocuments: async () => 0, create: async row => logs.push(row) },
    './sms.service': { toE164: phone => phone },
  });
  assert.equal(service.presentPhone('9876543210'), 'XXXXXX3210');
  const result = await service.bridgeCall({ bookingId: id(1), initiator: { id: id(2), role: 'DRIVER', phone: '9876543210' }, target: { id: id(8), role: 'USER', phone: '9123456789' } });
  assert.equal(result.mode, 'UNAVAILABLE');
  assert.equal(result.number, undefined);
  assert.equal(JSON.stringify(result).includes('9123456789'), false);
});

test('customer and driver messages reach both parties; retries are idempotent and outsiders cannot read', async () => {
  let server;
  const sockets = [];
  const saved = [];
  const booking = { _id: id(1), userId: id(8), driverId: id(2), status: 'ASSIGNED' };
  const query = value => {
    const q = { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
    for (const method of ['select', 'lean', 'limit']) q[method] = () => q;
    return q;
  };
  class Server {
    constructor() { server = this; }
    use(fn) { this.auth = fn; }
    on(name, fn) { if (name === 'connection') this.connection = fn; }
    to(room) { return { emit: (event, payload) => sockets.filter(s => s.rooms.has(room)).forEach(s => s.emit(event, payload)) }; }
    in(room) { return { fetchSockets: async () => sockets.filter(s => s.rooms.has(room)) }; }
  }
  const chatModel = {
    create: async row => {
      const doc = { ...row, _id: id(saved.length + 50), createdAt: new Date(), isRead: false };
      saved.push(doc); return doc;
    },
    findOneAndUpdate: async (filter, update) => saved.find(row => match(row, filter)) ?? chatModel.create(update.$setOnInsert),
    findOne: async filter => saved.find(row => match(row, filter)),
    updateMany: async (filter, update) => { saved.filter(row => match(row, filter)).forEach(row => Object.assign(row, update)); },
  };
  const socketUtil = load('src/utils/socket.util.ts', {
    'socket.io': { Server }, '@socket.io/redis-adapter': {},
    jsonwebtoken: { verify: token => token === 'driver' ? { driverId: id(2) } : { userId: token === 'customer' ? id(8) : id(9) } },
    mongoose: { Types }, '../config': { cors: {}, jwt: { secret: 'test-only' } },
    './redis.util': { duplicateRedisClient: () => ({}), connectWithTimeout: async () => false },
    '../models/chat-message.model': chatModel,
    '../models/booking.model': { findById: () => query(booking), find: filter => query(match(booking, filter) ? [booking] : []) },
    '../models/driver-location.model': { findOne: () => query(null) },
    '../models/driver.model': { findById: () => query({ isOnline: true, status: 'approved' }), updateOne: async () => {} },
    '../services/presence.service': { recordHeartbeat: async () => {} },
  });
  await socketUtil.initSocket({});
  function connect(token) {
    const handlers = {};
    const socket = { handshake: { auth: { token }, query: {} }, rooms: new Set(), received: [],
      on: (name, fn) => { handlers[name] = fn; },
      join: room => socket.rooms.add(room), leave: room => socket.rooms.delete(room),
      emit: (event, payload) => socket.received.push({ event, payload }),
      send: (name, ...data) => handlers[name](...data),
    };
    server.auth(socket, error => { if (error) throw error; });
    sockets.push(socket); server.connection(socket);
    return socket;
  }
  const customer = connect('customer');
  const driver = connect('driver');
  const outsider = connect('outsider');
  await customer.send('chat:join', { bookingId: id(1) });
  await driver.send('chat:join', { bookingId: id(1) });
  await outsider.send('chat:join', { bookingId: id(1) });
  assert.equal(outsider.rooms.has('booking:' + id(1)), false);
  let ack;
  const question = { bookingId: id(1), message: 'Are you coming?', messageType: 'TEXT', clientMessageId: id(100) };
  await customer.send('chat:message', question, result => { ack = result; });
  assert.equal(ack.success, true);
  assert.equal(saved.length, 1);
  // Another process may win a simultaneous upsert; recover its saved row.
  const upsert = chatModel.findOneAndUpdate;
  chatModel.findOneAndUpdate = async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); };
  await customer.send('chat:message', question, result => { ack = result; });
  assert.equal(ack.success, true);
  assert.equal(saved.length, 1);
  chatModel.findOneAndUpdate = upsert;
  assert.equal(driver.received.find(r => r.event === 'chat:message').payload.message, 'Are you coming?');
  await customer.send('chat:message', question, result => { ack = result; });
  assert.equal(ack.success, true);
  assert.equal(saved.length, 1);
  await driver.send('chat:message', { bookingId: id(1), message: 'I am coming', messageType: 'TEXT', clientMessageId: id(101) });
  assert.equal(saved[1].senderType, 'DRIVER');
  assert.equal(customer.received.filter(r => r.event === 'chat:message').at(-1).payload.message, 'I am coming');
  await outsider.send('chat:read', { bookingId: id(1) });
  assert.equal(saved.some(m => m.isRead), false);
  await driver.send('chat:read', { bookingId: id(1) });
  assert.equal(saved[0].isRead, true);
  assert.equal(saved[1].isRead, false);
});

test('vehicle options show every eligible type and recommend just the customer selection', async () => {
  const types = Array.from({ length: 12 }, (_, n) => ({ _id: id(n + 10), name: 'Vehicle ' + n,
    categoryCode: n < 3 ? '2W' : '4W', maxRangeKm: n < 5 ? 100 : 300, minRangeKm: 0,
    maxWeightKg: 200, allowIntraCity: true, allowInterCity: n >= 3, showOnHomeScreen: n < 5 }));
  const modules = Object.fromEntries([
    '../models/booking.model', '../models/driver.model', '../models/vehicle.model', '../models/vehicle-type.model',
    '../models/vehicle-category.model', '../models/promo-code.model', '../models/addon-service.model',
    '../models/prohibited-item.model', '../models/cancellation-reason.model', '../models/time-slot.model',
    '../models/app-config.model', '../services/promo.service', '../services/coin.service', '../services/invoice.service',
    '../services/booking-dispatch.service', '../services/payment.service', '../services/notification.service',
    '../services/enterprise.service', '../utils/socket.util', '../models/user-gst.model', '../services/routing.service',
    '../services/booking-number.service', '../services/vehicle-rate.service', '../services/tax.service', '../services/call-masking.service',
  ].map(name => [name, {}]));
  Object.assign(modules, { mongoose: { Types }, '../utils/redis.util': { cache: { get: async () => types } },
    '../services/vehicle-eligibility.service': load('src/services/vehicle-eligibility.service.ts', {}),
    '../models/goods-type.model': { findById: async () => ({ allowedVehicleTypes: [id(10)] }) },
    '../services/fare.service': { calculateFare: async () => ({ finalFare: 100 }) },
    '../services/user-discount.service': { discountAmountFor: async () => null },
    '../services/vehicle-rate.service': { resolveBookingCity: async () => 'Test City' },
  });
  const controller = load('src/controllers/booking.controller.ts', modules);
  async function options(serviceType, distanceKm, preferredVehicleTypeId) {
    let result;
    const res = { json: body => { result = body; }, status: () => res };
    await controller.getVehicleOptions({ body: { serviceType, distanceKm, durationMin: 10, preferredVehicleTypeId, goodsTypeId: id(100) } }, res);
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  }
  const city = await options('WITHIN_CITY', 20, id(21));
  assert.equal(city.length, 12);
  assert.equal(city.filter(o => o.isRecommended).length, 1);
  assert.equal(String(city[0].vehicleType._id), id(21));
  const outstation = await options('OUTSTATION', 150, id(10));
  assert.equal(outstation.length, 7);
  assert.equal(outstation.some(o => o.vehicleType.categoryCode === '2W'), false);
  types.splice(3);
  assert.equal((await options('OUTSTATION', 20, id(10))).length, 0);
});

function vehicleOptionsHarness(types = [], overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/booking.controller.ts'), 'utf8');
  const modules = Object.fromEntries([...source.matchAll(/from "([^"]+)"/g)].map(m => [m[1], {}]));
  const routeCalls = [], fareCalls = [];
  const session = { startTransaction() {}, async abortTransaction() {}, endSession() {} };
  Object.assign(modules, {
    mongoose: { Types, startSession: async () => session },
    '../services/vehicle-eligibility.service': load('src/services/vehicle-eligibility.service.ts', {}),
    '../utils/redis.util': { cache: { get: async () => types } },
    '../models/vehicle-type.model': { findById: async key => types.find(t => String(t._id) === String(key)) },
    '../services/routing.service': { getDistanceForLegs: async points => {
      routeCalls.push(points);
      return { distanceKm: 150, durationMin: 360, source: 'osrm' };
    } },
    '../services/fare.service': { calculateFare: async input => { fareCalls.push(input); return { finalFare: 100 }; } },
    '../services/user-discount.service': { discountAmountFor: async () => null },
    '../services/vehicle-rate.service': { resolveBookingCity: async () => 'Test City' },
    ...overrides,
  });
  const controller = load('src/controllers/booking.controller.ts', modules);
  async function invoke(body, method = 'getVehicleOptions') {
    let result, status = 200;
    const res = { json: payload => { result = payload; return res; }, status: code => { status = code; return res; } };
    await controller[method]({ body, user: { _id: id(99) } }, res);
    return { status, ...result };
  }
  return { invoke, routeCalls, fareCalls };
}
const bikeType = () => ({ _id: id(10), name: 'Bike', categoryCode: '2W', maxRangeKm: 100, isActive: true, isDeleted: false });
const truckType = () => ({ _id: id(11), name: 'Truck', categoryCode: '4W', maxRangeKm: 300, isActive: true, isDeleted: false });
const routeInput = () => ({ pickup: { lat: 12, lng: 77 }, drop: { lat: 13, lng: 78 }, serviceType: 'WITHIN_CITY', preferredVehicleTypeId: id(10) });

test('location preflight explains the selected two-wheeler limit and offers eligible Outstation alternatives without pricing', async () => {
  const h = vehicleOptionsHarness([bikeType(), truckType()]);
  const response = await h.invoke({ ...routeInput(), eligibilityOnly: true });
  assert.equal(response.success, true);
  assert.equal(response.eligibility.preferredVehicle.code, 'DISTANCE_LIMIT');
  assert.match(response.eligibility.preferredVehicle.message, /150.0 km.*Bike.*100.0 km/);
  assert.equal(response.eligibility.availableCount, 1);
  assert.equal(response.eligibility.outstationAvailableCount, 1);
  assert.equal(response.data.length, 0);
  assert.equal(h.fareCalls.length, 0);
});

test('distance boundary is inclusive; zero maximum stays unlimited; every stop is measured', async () => {
  const h = vehicleOptionsHarness([bikeType(), { ...truckType(), maxRangeKm: 0 }]);
  const exact = await h.invoke({ distanceKm: 100, durationMin: 20, eligibilityOnly: true, preferredVehicleTypeId: id(10) });
  assert.equal(exact.eligibility.preferredVehicle.code, 'AVAILABLE');
  const over = await h.invoke({ distanceKm: 100.01, durationMin: 20, eligibilityOnly: true, preferredVehicleTypeId: id(10) });
  assert.equal(over.eligibility.preferredVehicle.code, 'DISTANCE_LIMIT');
  const stop = { lat: 12.5, lng: 77.5 };
  await h.invoke({ ...routeInput(), stops: [stop], eligibilityOnly: true });
  assert.equal(h.routeCalls[0].length, 3);
  assert.equal(h.routeCalls[0][1].lat, stop.lat);
  const huge = await h.invoke({ distanceKm: 1000, durationMin: 2400, eligibilityOnly: true });
  assert.equal(huge.eligibility.availableCount, 1);
});

test('empty catalogue, Outstation with only bikes, and all distance-limited types give distinct successful empty results', async () => {
  for (const [types, serviceType, distanceKm, code] of [
    [[], 'WITHIN_CITY', 20, 'NO_ACTIVE_VEHICLES'],
    [[bikeType()], 'OUTSTATION', 20, 'OUTSTATION_UNAVAILABLE'],
    [[bikeType(), truckType()], 'WITHIN_CITY', 301, 'DISTANCE_LIMIT'],
  ]) {
    const r = await vehicleOptionsHarness(types).invoke({ serviceType, distanceKm, durationMin: 20 });
    assert.equal(r.status, 200);
    assert.equal(r.success, true);
    assert.equal(r.data.length, 0);
    assert.equal(r.eligibility.code, code);
    assert.ok(r.message.length);
  }
});

test('invalid coordinates, incomplete stops, invalid metrics and same-point trips are blocked with useful messages', async () => {
  const h = vehicleOptionsHarness([bikeType(), truckType()]);
  for (const body of [
    { pickup: { lat: null, lng: 77 }, drop: { lat: 13, lng: 78 } },
    { pickup: { lat: 91, lng: 77 }, drop: { lat: 13, lng: 78 } },
    { ...routeInput(), stops: [{ lat: 12, lng: null }] },
    { ...routeInput(), stops: 'not-an-array' },
    { distanceKm: -10, durationMin: 20 }, { distanceKm: 10, durationMin: -20 },
    { distanceKm: 'NaN', durationMin: 20 }, { distanceKm: 0, durationMin: 20 },
    { ...routeInput(), drop: { lat: 12, lng: 77 } },
  ]) {
    const r = await h.invoke(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.success, false);
    assert.ok(['INVALID_LOCATIONS', 'SAME_LOCATION'].includes(r.code));
  }
  assert.equal(h.routeCalls.length, 0);
});

test('coordinates on the equator work, client metrics cannot override a real route, and return trips through stops work', async () => {
  const h = vehicleOptionsHarness([truckType()]);
  const r = await h.invoke({ pickup: { lat: 0, lng: 77 }, drop: { lat: 1, lng: 78 }, distanceKm: 1, durationMin: 1, eligibilityOnly: true });
  assert.equal(r.eligibility.distanceKm, 150);
  const returning = await h.invoke({ pickup: { lat: 12, lng: 77 }, drop: { lat: 12, lng: 77 }, stops: [{ lat: 13, lng: 78 }], eligibilityOnly: true });
  assert.equal(returning.success, true);
  assert.equal(h.routeCalls[1].length, 3);
});

test('unresolved routing has a retryable response; fallback routing reports approximate distance including all stops', async () => {
  const unavailable = vehicleOptionsHarness([truckType()], { '../services/routing.service': { getDistanceForLegs: async () => null } });
  const r = await unavailable.invoke(routeInput());
  assert.equal(r.status, 503);
  assert.equal(r.code, 'ROUTE_UNAVAILABLE');
  const fallback = vehicleOptionsHarness([truckType()], { '../services/routing.service': { getDistanceForLegs: async points => ({ distanceKm: points.length * 10, durationMin: 72, source: 'straight' }) } });
  const f = await fallback.invoke({ ...routeInput(), stops: [{ lat: 12.5, lng: 77.5 }], eligibilityOnly: true });
  assert.equal(f.eligibility.distanceKm, 30);
  assert.equal(f.eligibility.distanceSource, 'straight');
});

test('one failed price preserves other vehicles; all failed prices are distinct from a distance limit', async () => {
  const h = vehicleOptionsHarness([bikeType(), truckType()], { '../services/fare.service': { calculateFare: async input => {
    if (String(input.vehicleTypeId) === id(10)) throw Error('missing rate');
    return { finalFare: 200 };
  } } });
  const partial = await h.invoke({ distanceKm: 20, durationMin: 40, preferredVehicleTypeId: id(10) });
  assert.equal(partial.data.length, 1);
  assert.equal(partial.eligibility.code, 'PARTIAL_PRICES');
  assert.equal(partial.eligibility.preferredVehicle.code, 'PRICE_UNAVAILABLE');
  const all = vehicleOptionsHarness([bikeType()], { '../services/fare.service': { calculateFare: async () => { throw Error('pricing offline'); } } });
  const r = await all.invoke({ distanceKm: 20, durationMin: 40 });
  assert.equal(r.status, 200);
  assert.equal(r.eligibility.code, 'PRICES_UNAVAILABLE');
  assert.equal(r.data.length, 0);
});

test('removed or inactive preferred vehicle is explained instead of silently selecting an alternative', async () => {
  const h = vehicleOptionsHarness([{ ...bikeType(), isActive: false }, truckType()]);
  const r = await h.invoke({ distanceKm: 20, durationMin: 40, preferredVehicleTypeId: id(10), eligibilityOnly: true });
  assert.equal(r.eligibility.availableCount, 1);
  assert.equal(r.eligibility.preferredVehicle.code, 'VEHICLE_UNAVAILABLE');
});

test('fare estimates and booking creation enforce distance and two-wheeler Outstation rules again', async () => {
  const h = vehicleOptionsHarness([bikeType(), { ...truckType(), isActive: false }]);
  for (const method of ['getFareEstimate', 'createBooking']) {
    for (const [vehicleTypeId, distanceKm, serviceType, expected] of [
      [id(10), 101, 'WITHIN_CITY', 'DISTANCE_LIMIT'],
      [id(10), 20, 'OUTSTATION', 'OUTSTATION_TWO_WHEELER'],
      [id(11), 20, 'WITHIN_CITY', 'VEHICLE_UNAVAILABLE'],
    ]) {
      const body = { distanceKm, durationMin: 20, vehicleTypeId, serviceType,
        ...(method === 'createBooking' ? { pickupLocation: {}, dropLocation: {} } : {}) };
      const r = await h.invoke(body, method);
      assert.equal(r.status, 400, method + JSON.stringify(r));
      assert.equal(r.code, expected);
    }
  }
  assert.equal(h.fareCalls.length, 0);
});
