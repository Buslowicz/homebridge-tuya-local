const assert = require('node:assert/strict');
const {once} = require('node:events');
const net = require('node:net');
const test = require('node:test');
const TuyaAccessory = require('../lib/TuyaAccessory');

test('shutdown cancels pending fake-device initialization', t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const log = Object.assign(() => {}, {warn: () => {}});
    const device = new TuyaAccessory({id: 'fake', key: Buffer.alloc(16), fake: true, connect: false, log});
    let changes = 0;
    device.on('change', () => { changes++; });
    device._connect();
    device.disconnect();
    t.mock.timers.tick(1000);
    assert.equal(changes, 0);
});

test('address updates close the previous TCP socket and shutdown cancels future reconnects', {timeout: 3000}, async t => {
    const peers = new Set();
    const server = net.createServer(peer => {
        peers.add(peer);
        peer.on('error', () => {});
        peer.resume();
    });
    let device;
    t.after(async () => {
        if (device) device.disconnect();
        for (const peer of peers) peer.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const log = () => {};
    for (const level of ['debug', 'info', 'warn', 'error']) log[level] = log;
    device = new TuyaAccessory({
        id: 'address-test', key: Buffer.alloc(16), name: 'Address test', version: '3.5',
        ip: '127.0.0.1', port: server.address().port, intro: false, connect: false, log
    });
    let connected = once(server, 'connection');
    device._connect();
    const [firstPeer] = await connected;
    const oldSocket = device._socket;
    const closed = once(firstPeer, 'close');
    // Equivalent textual spelling lets the test exercise migration entirely on loopback.
    device.context.ip = '127.000.000.001';
    connected = once(server, 'connection');
    assert.equal(device.updateIP('127.0.0.1'), true);
    await connected;
    await closed;
    assert.equal(oldSocket.destroyed, true);
    const newSocket = device._socket;
    assert.notEqual(newSocket, oldSocket);
    assert.equal(device.updateIP('127.0.0.1'), false);
    assert.equal(device.updateIP('invalid-address'), false);
    assert.equal(device._socket, newSocket);
    device.disconnect();
    assert.equal(newSocket.destroyed, true);
    assert.equal(device.updateIP('127.0.0.2'), false);
    device._connect();
    assert.equal(device._socket, newSocket, 'stopped devices cannot reconnect from queued callbacks');
    assert.deepEqual(device._attemptTimeouts, []);
});
