const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const {EventEmitter, once} = require('node:events');
const os = require('node:os');
const test = require('node:test');
const Discovery = require('../lib/TuyaDiscovery').constructor;

const UDP_KEY = Buffer.from('6c1ec8e2bb9bb59ab50b0daf649b410a', 'hex');
const V35_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function fixture() {
    const logs = [];
    const log = {};
    for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (...args) => logs.push(args);
    const discovery = new Discovery();
    discovery.log = log;
    return {discovery, logs, log};
}

function packet(data, modern = true, encrypted = false) {
    let payload = Buffer.from(JSON.stringify(data));
    if (modern) {
        payload = Buffer.concat([Buffer.alloc(4), payload]);
        const header = Buffer.alloc(18);
        header.writeUInt32BE(0x6699);
        header.writeUInt32BE(35, 10);
        header.writeUInt32BE(12 + payload.length + 16, 14);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-128-gcm', V35_KEY, iv);
        cipher.setAAD(header.subarray(4));
        const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
        return Buffer.concat([header, iv, ciphertext, cipher.getAuthTag(), Buffer.from('00009966', 'hex')]);
    }
    if (encrypted) {
        const cipher = crypto.createCipheriv('aes-128-ecb', UDP_KEY, null);
        payload = Buffer.concat([cipher.update(payload), cipher.final()]);
    }
    const header = Buffer.alloc(20);
    header.writeUInt32BE(0x55aa);
    header.writeUInt32BE(payload.length + 12, 12);
    return Buffer.concat([header, payload, Buffer.from('000000000000aa55', 'hex')]);
}

function deliver(discovery, data, {address = data.ip, modern = true, encrypted = false} = {}) {
    discovery._onDgramMessage(modern ? 7000 : encrypted ? 6667 : 6666, packet(data, modern, encrypted), {address});
}

test('discovery admits only validated public fields and source-matching IPv4 addresses', () => {
    const {discovery} = fixture();
    const found = [];
    discovery.on('discover', data => found.push(data));
    const valid = {gwId: 'test-device', ip: '127.0.0.1', version: '3.5', key: 'secret', name: 'untrusted', dps: {1: true}};
    deliver(discovery, valid);
    assert.deepEqual(found, [{id: 'test-device', ip: '127.0.0.1', version: '3.5'}]);
    for (const data of [
        {...valid, gwId: 'mismatch', ip: '192.168.1.10'},
        {...valid, gwId: '\nforged'}, {...valid, gwId: 'a'.repeat(129)},
        {...valid, gwId: ['array']}, {...valid, ip: '999.2.3.4'},
        {...valid, gwId: 'bad-version', version: '3.5\nsecret'}
    ]) deliver(discovery, data, {address: '127.0.0.1'});
    assert.equal(found.length, 1);
});

test('legacy plaintext and encrypted discovery remain supported', () => {
    const {discovery} = fixture();
    const found = [];
    discovery.on('discover', data => found.push(data));
    deliver(discovery, {gwId: 'plain', ip: '127.0.0.1', version: '3.1'}, {modern: false});
    deliver(discovery, {gwId: 'encrypted', ip: '127.0.0.1', version: '3.3'}, {modern: false, encrypted: true});
    assert.deepEqual(found, [
        {id: 'plain', ip: '127.0.0.1', version: '3.1'},
        {id: 'encrypted', ip: '127.0.0.1', version: '3.3'}
    ]);
});

test('discovery retains protocol on address changes and keeps monitoring configured IDs', async () => {
    const {discovery} = fixture();
    discovery._running = true;
    discovery.limitedIds = ['configured'];
    const changes = [];
    discovery.on('ipChanged', data => changes.push(data));
    deliver(discovery, {gwId: 'configured', ip: '127.0.0.1', version: '3.5'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discovery._running, true);
    deliver(discovery, {gwId: 'configured', ip: '127.0.0.2'});
    deliver(discovery, {gwId: 'configured', ip: '127.0.0.2'});
    assert.deepEqual(changes, [{id: 'configured', oldIp: '127.0.0.1', newIp: '127.0.0.2', version: '3.5'}]);
    discovery.stop();
});

test('malformed, truncated and unauthenticated discovery never throws or logs raw payloads', () => {
    const {discovery, logs} = fixture();
    const found = [];
    discovery.on('discover', data => found.push(data));
    const valid = packet({gwId: 'test-device', ip: '127.0.0.1', key: 'raw-secret'});
    for (let length = 0; length < valid.length; length++) {
        assert.doesNotThrow(() => discovery._onDgramMessage(7000, valid.subarray(0, length), {address: '127.0.0.1'}));
    }
    const forged = Buffer.from(valid);
    forged[forged.length - 5] ^= 1;
    const wrongLength = Buffer.from(valid);
    wrongLength.writeUInt32BE(0xffffffff, 14);
    for (const msg of [forged, wrongLength, Buffer.alloc(65536), Buffer.from('raw-secret')]) {
        assert.doesNotThrow(() => discovery._onDgramMessage(7000, msg, {address: '127.0.0.1'}));
    }
    assert.deepEqual(found, []);
    assert.doesNotMatch(JSON.stringify(logs), /raw-secret|7261772d736563726574/);
});

test('unknown discovery state is bounded while configured device updates remain tracked', () => {
    const {discovery} = fixture();
    discovery.limitedIds = ['configured'];
    deliver(discovery, {gwId: 'configured', ip: '127.0.0.1', version: '3.5'});
    for (let index = 0; index < 300; index++) deliver(discovery, {gwId: `unknown-${index}`, ip: '127.0.0.1'});
    assert.ok(discovery.discovered.size <= 257);
    assert.ok(discovery.discovered.has('configured'));
    const changes = [];
    discovery.on('ipChanged', data => changes.push(data));
    deliver(discovery, {gwId: 'configured', ip: '127.0.0.2'});
    assert.equal(changes.length, 1);
});

function fakeSockets(t) {
    const sockets = [];
    t.mock.method(dgram, 'createSocket', () => {
        const socket = new EventEmitter();
        socket.bind = port => {socket.port = port;};
        socket.close = () => {socket.closed = true; socket.emit('close');};
        socket.setBroadcast = () => {};
        socket.packets = [];
        socket.send = (...args) => {
            socket.sent = (socket.sent || 0) + 1;
            socket.packets.push(args.slice(0, -1));
            args.at(-1)(null);
        };
        sockets.push(socket);
        return socket;
    });
    t.mock.method(os, 'networkInterfaces', () => ({test: [{family: 'IPv4', internal: false, address: '192.168.8.4', netmask: '255.255.254.0'}]}));
    return sockets;
}

test('probes start after listening, repeat every minute and stop with retries and listeners cleared', t => {
    t.mock.timers.enable({apis: ['setInterval', 'setTimeout']});
    const sockets = fakeSockets(t);
    const {discovery, log} = fixture();
    discovery.start({ids: ['configured'], log});
    assert.deepEqual(sockets.map(socket => socket.port), [6666, 6667, 7000]);
    const socket = sockets[2];
    assert.equal(socket.sent, undefined);
    socket.emit('listening');
    assert.equal(socket.sent, 1);
    assert.equal(socket.packets[0][1], 7000);
    assert.equal(socket.packets[0][2], '192.168.9.255', 'broadcast must respect a /23 netmask');
    t.mock.timers.tick(60000);
    assert.equal(socket.sent, 2);
    discovery.start({ids: ['configured'], log});
    assert.equal(sockets.length, 3, 'repeated start must not create extra sockets or timers');
    sockets[0].emit('error', Object.assign(new Error('fixture'), {code: 'EADDRINUSE'}));
    discovery.stop();
    t.mock.timers.tick(120000);
    assert.equal(sockets.length, 3, 'stopped discovery must not restart a failed listener');
    assert.equal(socket.sent, 2);
    for (const item of sockets) {
        assert.ok(item.closed);
        assert.equal(item.eventNames().length, 0);
    }
});


test('probes every eligible IPv4 interface with its own source address and subnet broadcast', t => {
    const sockets = fakeSockets(t);
    t.mock.method(os, 'networkInterfaces', () => ({
        first: [
            {family: 'IPv4', internal: false, address: '192.168.8.4', netmask: '255.255.254.0'},
            {family: 'IPv4', internal: false, address: '192.168.8.4', netmask: '255.255.254.0'}
        ],
        second: [{family: 'IPv4', internal: false, address: '10.20.30.40', netmask: '255.255.0.0'}],
        ignored: [
            {family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0'},
            {family: 'IPv6', internal: false, address: '::1', netmask: 'ffff::'},
            {family: 'IPv4', internal: false, address: 'invalid', netmask: '255.255.0.0'}
        ]
    }));
    const {discovery, log} = fixture();
    t.after(() => discovery.stop());
    discovery.start({log});
    sockets[2].emit('listening');
    assert.deepEqual(sockets[2].packets.map(([, port, address]) => [port, address]), [
        [7000, '192.168.9.255'], [7000, '10.20.255.255']
    ]);
    const sources = sockets[2].packets.map(([msg]) => {
        assert.equal(msg.readUInt32BE(10), 0x25);
        const decipher = crypto.createDecipheriv('aes-128-gcm', V35_KEY, msg.subarray(18, 30));
        decipher.setAAD(msg.subarray(4, 18));
        decipher.setAuthTag(msg.subarray(msg.length - 20, msg.length - 4));
        return JSON.parse(Buffer.concat([decipher.update(msg.subarray(30, msg.length - 20)), decipher.final()]));
    });
    assert.deepEqual(sources, [{from: 'app', ip: '192.168.8.4'}, {from: 'app', ip: '10.20.30.40'}]);
});

test('listener errors retry while running and stop during binding safely closes sockets', t => {
    t.mock.timers.enable({apis: ['setInterval', 'setTimeout']});
    const sockets = fakeSockets(t);
    const {discovery, log} = fixture();
    t.after(() => discovery.stop());
    discovery.start({log});
    sockets[2].emit('error', Object.assign(new Error('raw-secret'), {code: 'EADDRINUSE'}));
    t.mock.timers.tick(15000);
    assert.equal(sockets.length, 4);
    assert.equal(sockets[3].port, 7000);
    assert.ok(sockets[2].closed);
    discovery.stop();
    t.mock.timers.tick(120000);
    assert.equal(sockets.length, 4);
    assert.ok(sockets.every(socket => socket.closed && socket.eventNames().length === 0));
});


test('send callback failures do not expose errors or payloads and shutdown tolerates late socket errors', t => {
    const sockets = fakeSockets(t);
    const {discovery, log, logs} = fixture();
    discovery.start({log});
    sockets[2].send = (...args) => args.at(-1)(new Error('raw-secret'));
    sockets[2].emit('listening');
    for (const socket of sockets) {
        socket.close = () => {
            socket.closed = true;
            socket.emit('error', new Error('raw-secret'));
            socket.emit('close');
        };
    }
    assert.doesNotThrow(() => discovery.stop());
    assert.doesNotMatch(JSON.stringify(logs), /raw-secret/);
    assert.ok(sockets.every(socket => socket.closed && socket.eventNames().length === 0));
});

test('immediate shutdown while real UDP bind is pending leaves sockets closed', {timeout: 3000}, async () => {
    const {discovery, log} = fixture();
    discovery.start({log});
    const sockets = Object.values(discovery._servers);
    // The service clears external socket listeners during stop, so use the
    // native close callback to observe completion independently of those listeners.
    const close = dgram.Socket.prototype.close;
    const completions = sockets.map(socket => new Promise(resolve => {
        socket.close = () => close.call(socket, resolve);
    }));
    discovery.stop();
    await Promise.all(completions);
    for (const socket of sockets) assert.equal(socket.eventNames().length, 0);
    assert.equal(discovery._running, false);
});

test('active probe uses bound UDP 7000 socket and authenticates local source IP and command 37', {timeout: 3000}, async t => {
    // A /32 loopback fixture maps directed broadcast back to the listener itself.
    // No packet is sent to an actual LAN interface in this test.
    t.mock.method(os, 'networkInterfaces', () => ({
        test: [{family: 'IPv4', internal: false, address: '127.0.0.1', netmask: '255.255.255.255'}],
        ignored: [{family: 'IPv4', internal: true, address: '192.168.1.1', netmask: '255.255.255.0'}]
    }));
    const {discovery, log} = fixture();
    t.after(() => discovery.stop());
    discovery.start({ids: [], log});
    const [msg, info] = await once(discovery._servers[7000], 'message');
    assert.equal(info.port, 7000);
    assert.equal(info.address, '127.0.0.1');
    assert.equal(msg.readUInt32BE(10), 0x25);
    assert.equal(msg.readUInt32BE(14), msg.length - 22);
    const cipher = crypto.createDecipheriv('aes-128-gcm', V35_KEY, msg.subarray(18, 30));
    cipher.setAAD(msg.subarray(4, 18));
    cipher.setAuthTag(msg.subarray(msg.length - 20, msg.length - 4));
    const payload = Buffer.concat([cipher.update(msg.subarray(30, msg.length - 20)), cipher.final()]);
    assert.deepEqual(JSON.parse(payload), {from: 'app', ip: '127.0.0.1'});
    const discovered = once(discovery, 'discover');
    discovery._servers[7000].send(packet({gwId: 'real-udp-fixture', ip: '127.0.0.1', version: '3.5'}), 7000, '127.0.0.1');
    assert.deepEqual((await discovered)[0], {id: 'real-udp-fixture', ip: '127.0.0.1', version: '3.5'});
});
