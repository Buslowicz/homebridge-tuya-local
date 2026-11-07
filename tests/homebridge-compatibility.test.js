const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const test = require('node:test');

// Load the real plugin API without booting Homebridge's unrelated Matter server.
const {HomebridgeAPI} = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
const initialize = require('../index');
const BaseAccessory = require('../lib/BaseAccessory');
const createEnergyCharacteristics = require('../lib/EnergyCharacteristics');

function logger() {
    const log = () => {};
    for (const level of ['debug', 'info', 'warn', 'error']) log[level] = log;
    return log;
}

function setup({frozen = false, devices = []} = {}) {
    const api = new HomebridgeAPI();
    // Keep real Homebridge classes/enums, isolating namespace mutation between tests.
    api.hap = frozen ? Object.freeze({...api.hap}) : {...api.hap};
    let Platform;
    api.once('registerPlatform', (name, constructor, plugin) => {
        assert.equal(name, 'TuyaLan');
        assert.equal(plugin, 'homebridge-tuya-local');
        Platform = constructor;
    });
    initialize(api);
    return {api, createPlatform: () => new Platform(logger(), {devices}, api)};
}

function device(context) {
    const result = new EventEmitter();
    result.context = context;
    result.state = {};
    result._connect = () => {};
    return result;
}

test('registers an accessory using Homebridge 2 hap.Categories', () => {
    const {api, createPlatform} = setup();
    assert.equal(api.serverVersion, '2.5.0');
    assert.equal(api.hap.Accessory.Categories, undefined);
    const platform = createPlatform();
    const UUID = api.hap.uuid.generate('category-regression');
    const outlet = device({UUID, id: 'test-device-category', name: 'Test outlet', type: 'outlet'});
    assert.doesNotThrow(() => platform.addAccessory(outlet));
    assert.equal(platform.cachedAccessories.get(UUID).accessory.category, api.hap.Categories.OUTLET);
});

test('keeps a frozen HAP namespace untouched and supplies energy characteristics to accessories', () => {
    const {api, createPlatform} = setup({frozen: true});
    const originalHap = api.hap;
    const originalKeys = Reflect.ownKeys(originalHap);
    let platform;
    assert.doesNotThrow(() => { platform = createPlatform(); });
    assert.equal(api.hap, originalHap);
    assert.deepEqual(Reflect.ownKeys(api.hap), originalKeys);
    assert.equal(Object.hasOwn(api.hap, 'EnergyCharacteristics'), false);
    assert.equal(platform.hap.Characteristic, api.hap.Characteristic);
    const UUID = api.hap.uuid.generate('energy-adapter-regression');
    const outlet = device({
        UUID, id: 'test-device-energy', name: 'Energy outlet', type: 'outlet',
        voltsId: '20', ampsId: '18', wattsId: '19'
    });
    platform.addAccessory(outlet);
    const handler = platform.cachedAccessories.get(UUID);
    assert.equal(handler.hap, platform.hap);
    outlet.state = {1: true, 18: 1250, 19: 750, 20: 2300};
    outlet.emit('change', outlet.state, outlet.state);
    const service = handler.accessory.getService(api.hap.Service.Outlet);
    assert.equal(service.getCharacteristic(platform.hap.EnergyCharacteristics.Volts).value, 230);
    assert.equal(service.getCharacteristic(platform.hap.EnergyCharacteristics.Amperes).value, 1.25);
    assert.equal(service.getCharacteristic(platform.hap.EnergyCharacteristics.Watts).value, 75);
    const changes = {18: 2000, 19: 1000, 20: 2400};
    Object.assign(outlet.state, changes);
    outlet.emit('change', changes, outlet.state);
    assert.equal(service.getCharacteristic(platform.hap.EnergyCharacteristics.Volts).value, 240);
    assert.equal(service.getCharacteristic(platform.hap.EnergyCharacteristics.Amperes).value, 2);
    assert.equal(service.getCharacteristic(platform.hap.EnergyCharacteristics.Watts).value, 100);
});

test('energy factory preserves UUIDs and properties using real Homebridge 2 enums', () => {
    const {hap} = new HomebridgeAPI();
    assert.equal(hap.Characteristic.Formats, undefined);
    assert.equal(hap.Characteristic.Perms, undefined);
    const classes = createEnergyCharacteristics(hap);
    const expected = [
        ['Amperes', 'E863F126-079E-48FF-8F27-9C2605A29F52', 'Amperes', hap.Formats.FLOAT, 'A', 0.001],
        ['KilowattHours', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'Total Consumption', hap.Formats.FLOAT, 'kWh', 0.001],
        ['KilowattVoltAmpereHour', 'E863F127-079E-48FF-8F27-9C2605A29F52', 'Apparent Energy', hap.Formats.UINT32, 'kVAh', 1],
        ['VoltAmperes', 'E863F110-079E-48FF-8F27-9C2605A29F52', 'Apparent Power', hap.Formats.UINT16, 'VA', 1],
        ['Volts', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'Volts', hap.Formats.FLOAT, 'V', 0.1],
        ['Watts', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'Consumption', hap.Formats.FLOAT, 'W', 0.1]
    ];
    for (const [name, UUID, displayName, format, unit, minStep] of expected) {
        const characteristic = new classes[name]();
        assert.ok(characteristic instanceof hap.Characteristic);
        assert.equal(classes[name].UUID, UUID);
        assert.equal(characteristic.UUID, UUID);
        assert.equal(characteristic.displayName, displayName);
        assert.equal(characteristic.props.format, format);
        assert.equal(characteristic.props.unit, unit);
        assert.equal(characteristic.props.minStep, minStep);
        assert.equal(characteristic.props.minValue, 0);
        assert.equal(characteristic.props.maxValue, 65535);
        assert.deepEqual(characteristic.props.perms, [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY]);
        assert.equal(characteristic.value, 0);
    }
});

test('restores a cached heater and faults its writable notifying Active characteristic', () => {
    const id = 'test-cached-heater';
    const {api, createPlatform} = setup({devices: [{id, type: 'simpleheater'}]});
    const platform = createPlatform();
    const UUID = api.hap.uuid.generate(`homebridge-tuya-local:${id}`);
    const accessory = new api.platformAccessory('Cached heater', UUID, api.hap.Categories.AIR_HEATER);
    const service = accessory.addService(api.hap.Service.HeaterCooler, 'Cached heater');
    const active = service.getCharacteristic(api.hap.Characteristic.Active).updateValue(1);
    const current = service.getCharacteristic(api.hap.Characteristic.CurrentTemperature).updateValue(20);
    // Timed-write is an additional valid permission; writable+notify must still qualify.
    active.setProps({perms: [...active.props.perms, api.hap.Perms.TIMED_WRITE]});
    assert.doesNotThrow(() => platform.configureAccessory(accessory));
    assert.equal(platform.cachedAccessories.get(UUID), accessory);
    assert.equal(active.statusCode, api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    assert.equal(current.statusCode, api.hap.HAPStatus.SUCCESS);
});

test('live unreachable handling faults Active, preserves read-only values, and can fault again after reconnect', () => {
    const {api, createPlatform} = setup();
    const platform = createPlatform();
    const accessory = new api.platformAccessory('Live heater', api.hap.uuid.generate('live-heater'));
    const service = accessory.addService(api.hap.Service.HeaterCooler, 'Live heater');
    const active = service.getCharacteristic(api.hap.Characteristic.Active).updateValue(1);
    active.setProps({perms: [...active.props.perms, api.hap.Perms.TIMED_WRITE]});
    const current = service.getCharacteristic(api.hap.Characteristic.CurrentTemperature).updateValue(20);
    const heater = device({name: 'Live heater', type: 'simpleheater'});
    new BaseAccessory(platform, accessory, heater, false);
    assert.doesNotThrow(() => heater.emit('unreachable'));
    assert.equal(active.statusCode, api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    assert.equal(current.statusCode, api.hap.HAPStatus.SUCCESS);
    active.updateValue(1);
    heater.emit('unreachable');
    assert.equal(active.statusCode, api.hap.HAPStatus.SUCCESS, 'repeated unreachable notifications are idempotent');
    heater.emit('connect');
    heater.emit('unreachable');
    assert.equal(active.statusCode, api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
});
