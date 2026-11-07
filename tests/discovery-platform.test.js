const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {HomebridgeAPI} = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
const initialize = require('../index');
const discovery = require('../lib/TuyaDiscovery');
const TuyaAccessory = require('../lib/TuyaAccessory');

function platform(t, devices) {
    t.mock.timers.enable({apis: ['setTimeout']});
    let connections = 0;
    let starts = 0;
    let stops = 0;
    t.mock.method(TuyaAccessory.prototype, '_connect', function() { connections++; });
    t.mock.method(discovery, 'start', () => { starts++; return discovery; });
    t.mock.method(discovery, 'stop', () => { stops++; return discovery; });
    const messages = [];
    const log = (...args) => messages.push(args.join(' '));
    for (const level of ['info', 'warn', 'debug', 'error']) log[level] = log;
    const api = new HomebridgeAPI();
    let Platform;
    api.once('registerPlatform', (name, constructor) => { Platform = constructor; });
    initialize(api);
    const instance = new Platform(log, {devices}, api);
    t.after(() => {
        api.emit('shutdown');
        discovery.removeAllListeners();
    });
    instance.discoverDevices();
    return {instance, api, messages, connections: () => connections, starts: () => starts, stops: () => stops};
}

const heater = () => ({id: 'test-heater', name: 'Test heater', type: 'SimpleHeater', key: '0123456789abcdef', version: '3.5'});

test('discovers a configured heater without IP and updates the same connection when its address changes', t => {
    const config = heater();
    const p = platform(t, [config]);
    discovery.emit('discover', {id: config.id, ip: '192.168.1.10', version: '3.5', key: 'untrusted', type: 'Outlet'});
    const handler = [...p.instance.cachedAccessories.values()][0];
    assert.ok(handler);
    assert.equal(handler.device.context.key.toString(), config.key);
    assert.equal(handler.device.context.type, 'SimpleHeater');
    const connection = handler.device;
    discovery.emit('ipChanged', {id: config.id, oldIp: '192.168.1.10', newIp: '192.168.1.20', version: '3.5'});
    assert.equal(connection.context.ip, '192.168.1.20');
    assert.equal([...p.instance.cachedAccessories.values()][0], handler);
    assert.equal(p.connections(), 2);
    discovery.emit('discover', {id: config.id, ip: '192.168.1.20', version: '3.5'});
    t.mock.timers.tick(60000);
    assert.equal(p.connections(), 2, 'duplicates and fallback must not create extra connections');
    assert.equal(config.ip, undefined, 'discovery does not rewrite config.json inputs');
});

test('moves a fallback connection to its discovered IP without replacing the accessory', t => {
    const config = {...heater(), ip: '192.168.1.5'};
    const p = platform(t, [config]);
    t.mock.timers.tick(60000);
    const handler = [...p.instance.cachedAccessories.values()][0];
    assert.ok(handler);
    discovery.emit('discover', {id: config.id, ip: '192.168.1.25', version: '3.5'});
    assert.equal(handler.device.context.ip, '192.168.1.25');
    assert.equal([...p.instance.cachedAccessories.values()][0], handler);
    assert.equal(p.connections(), 2);
});

test('finds unknown devices with an empty configuration without connecting or logging keys', t => {
    const p = platform(t, []);
    assert.equal(p.starts(), 1);
    discovery.emit('discover', {id: 'new-device', ip: '192.168.1.30', version: '3.5', key: 'DO_NOT_LOG'});
    assert.equal(p.connections(), 0);
    assert.equal(p.instance.cachedAccessories.size, 0);
    assert.ok(p.messages.some(message => message.includes('new-device') && message.includes('192.168.1.30')));
    assert.ok(p.messages.every(message => !message.includes('DO_NOT_LOG')));
});

test('ignores disabled devices and cleans up listeners and fallback timers on shutdown', t => {
    const p = platform(t, [{...heater(), disabled: true, ip: '192.168.1.10'}]);
    p.api.emit('shutdown');
    assert.equal(p.stops(), 1);
    assert.equal(discovery.listenerCount('discover'), 0);
    assert.equal(discovery.listenerCount('ipChanged'), 0);
    t.mock.timers.tick(60000);
    assert.equal(p.connections(), 0);
});

test('missing local keys are reported without connecting to discovered devices', t => {
    const p = platform(t, [{...heater(), key: ''}]);
    discovery.emit('discover', {id: 'test-heater', ip: '192.168.1.10', version: '3.5'});
    t.mock.timers.tick(60000);
    assert.equal(p.connections(), 0);
    assert.equal(p.instance.cachedAccessories.size, 0);
    assert.ok(p.messages.some(message => message.includes('local key')));
});
