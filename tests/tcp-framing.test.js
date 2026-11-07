const assert = require('node:assert/strict');
const {once} = require('node:events');
const net = require('node:net');
const test = require('node:test');
const TuyaAccessory = require('../lib/TuyaAccessory');

const log = () => {};
for (const level of ['debug', 'info', 'warn', 'error']) log[level] = log;

// Opaque framing fixtures: the queue is stubbed only AFTER the TCP receiver,
// so these tests exercise buffering and packet boundaries without device crypto.
function frame(version, sequence = 1, embeddedFooter = false) {
    const payload = Buffer.alloc(version === '3.5' ? 44 : 12, sequence);
    if (embeddedFooter) Buffer.from(version === '3.5' ? '00009966' : '0000aa55', 'hex').copy(payload, 4);
    if (version === '3.5') {
        const header = Buffer.alloc(18);
        header.writeUInt32BE(0x6699, 0);
        header.writeUInt32BE(sequence, 6);
        header.writeUInt32BE(8, 10);
        header.writeUInt32BE(payload.length, 14);
        return Buffer.concat([header, payload, Buffer.from('00009966', 'hex')]);
    }
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x55aa, 0);
    header.writeUInt32BE(sequence, 4);
    header.writeUInt32BE(8, 8);
    header.writeUInt32BE(payload.length + 8, 12);
    return Buffer.concat([header, payload, Buffer.from('000000000000aa55', 'hex')]);
}

async function receiver(t, version) {
    const server = net.createServer();
    const peers = new Set();
    server.on('connection', peer => {
        peers.add(peer);
        peer.on('error', () => {});
        peer.resume();
    });
    let device;
    t.after(async () => {
        if (device && device._socket) {
            for (const name of ['_connTimeout', '_pinger', '_errorReconnect', '_sessionKeyTimeout']) clearTimeout(device._socket[name]);
            for (const timer of device._attemptTimeouts || []) clearTimeout(timer);
            device._socket.removeAllListeners();
            device._socket.destroy();
        }
        for (const peer of peers) peer.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connected = once(server, 'connection');
    device = new TuyaAccessory({
        id: 'loopback-fixture', key: Buffer.alloc(16), name: 'Framing fixture',
        ip: '127.0.0.1', port: server.address().port, version, intro: false, connect: false, log
    });
    const packets = [];
    device._msgQueue.push = ({msg}) => packets.push(Buffer.from(msg));
    device._connect();
    const [peer] = await connected;
    return {
        packets,
        async send(chunk) {
            const received = once(device._socket, 'data');
            peer.write(chunk);
            await received;
        }
    };
}

for (const version of ['3.3', '3.5']) {
    test(`${version}: receives a complete frame through TCP`, {timeout: 3000}, async t => {
        const connection = await receiver(t, version);
        const packet = frame(version);
        await connection.send(packet);
        assert.deepEqual(connection.packets, [packet]);
    });

    test(`${version}: buffers split headers, payloads and footers through TCP`, {timeout: 3000}, async t => {
        const connection = await receiver(t, version);
        const packet = frame(version);
        const cuts = [2, 8, packet.length - 2, packet.length];
        let start = 0;
        for (const end of cuts) {
            await connection.send(packet.subarray(start, end));
            assert.equal(connection.packets.length, end === packet.length ? 1 : 0);
            start = end;
        }
        assert.deepEqual(connection.packets, [packet]);
    });

    test(`${version}: separates coalesced frames and ignores footer bytes inside payloads`, {timeout: 3000}, async t => {
        const connection = await receiver(t, version);
        const first = frame(version, 1, true);
        const second = frame(version, 2);
        await connection.send(Buffer.concat([first, second]));
        assert.deepEqual(connection.packets, [first, second]);
    });
}

test('3.5: accepts classic fallback frames in wire order', {timeout: 3000}, async t => {
    const connection = await receiver(t, '3.5');
    const classic = frame('3.3');
    const modern = frame('3.5');
    await connection.send(Buffer.concat([classic, modern, classic]));
    assert.deepEqual(connection.packets, [classic, modern, classic]);
});

test('resynchronizes after invalid lengths, oversized lengths and damaged footers', {timeout: 3000}, async t => {
    const connection = await receiver(t, '3.5');
    const expected = [];
    for (const version of ['3.3', '3.5']) {
        const valid = frame(version);
        const headerLength = version === '3.5' ? 18 : 16;
        const lengthOffset = version === '3.5' ? 14 : 12;
        const tooShort = Buffer.from(valid.subarray(0, headerLength));
        tooShort.writeUInt32BE(version === '3.5' ? 27 : 7, lengthOffset);
        const oversized = Buffer.from(valid.subarray(0, headerLength));
        oversized.writeUInt32BE(1024 * 1024 + 1, lengthOffset);
        const badFooter = Buffer.from(valid);
        badFooter[badFooter.length - 1] ^= 0xff;
        for (const malformed of [tooShort, oversized, badFooter]) {
            await connection.send(Buffer.concat([malformed, valid]));
            expected.push(valid);
            assert.deepEqual(connection.packets, expected, `${version}: invalid frames must not block or enter the message queue`);
        }
    }
});
