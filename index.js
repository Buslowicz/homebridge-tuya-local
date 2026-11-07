const TuyaAccessory = require('./lib/TuyaAccessory');
const TuyaDiscovery = require('./lib/TuyaDiscovery');
const {isIP} = require('net');

const OccupancySensorAccessory = require('./lib/OccupancySensorAccessory');
const OutletAccessory = require('./lib/OutletAccessory');
const SimpleLightAccessory = require('./lib/SimpleLightAccessory');
const MultiOutletAccessory = require('./lib/MultiOutletAccessory');
const CustomMultiOutletAccessory = require('./lib/CustomMultiOutletAccessory');
const RGBTWLightAccessory = require('./lib/RGBTWLightAccessory');
const RGBTWOutletAccessory = require('./lib/RGBTWOutletAccessory');
const TWLightAccessory = require('./lib/TWLightAccessory');
const AirConditionerAccessory = require('./lib/AirConditionerAccessory');
const AirPurifierAccessory = require('./lib/AirPurifierAccessory');
const DehumidifierAccessory = require('./lib/DehumidifierAccessory');
const ConvectorAccessory = require('./lib/ConvectorAccessory');
const GarageDoorAccessory = require('./lib/GarageDoorAccessory');
const SimpleDimmerAccessory = require('./lib/SimpleDimmerAccessory');
const SimpleDimmer2Accessory = require('./lib/SimpleDimmer2Accessory');
const SimpleBlindsAccessory = require('./lib/SimpleBlindsAccessory');
const SimpleHeaterAccessory = require('./lib/SimpleHeaterAccessory');
const SimpleFanAccessory = require('./lib/SimpleFanAccessory');
const SimpleFanLightAccessory = require('./lib/SimpleFanLightAccessory');
const SwitchAccessory = require('./lib/SwitchAccessory');
const ValveAccessory = require('./lib/ValveAccessory');
const OilDiffuserAccessory = require('./lib/OilDiffuserAccessory');

const PLUGIN_NAME = 'homebridge-tuya-local';
const PLATFORM_NAME = 'TuyaLan';

const CLASS_DEF = {
    occupancysensor: OccupancySensorAccessory,
    outlet: OutletAccessory,
    simplelight: SimpleLightAccessory,
    rgbtwlight: RGBTWLightAccessory,
    rgbtwoutlet: RGBTWOutletAccessory,
    twlight: TWLightAccessory,
    multioutlet: MultiOutletAccessory,
    custommultioutlet: CustomMultiOutletAccessory,
    airconditioner: AirConditionerAccessory,
    airpurifier: AirPurifierAccessory,
    dehumidifier: DehumidifierAccessory,
    convector: ConvectorAccessory,
    garagedoor: GarageDoorAccessory,
    simpledimmer: SimpleDimmerAccessory,
    simpledimmer2: SimpleDimmer2Accessory,
    simpleblinds: SimpleBlindsAccessory,
    simpleheater: SimpleHeaterAccessory,
    switch: SwitchAccessory,
    fan: SimpleFanAccessory,
    fanlight: SimpleFanLightAccessory,
    watervalve: ValveAccessory,
    oildiffuser: OilDiffuserAccessory
};

let Characteristic, PlatformAccessory, Service, Categories, AdaptiveLightingController, UUID;

module.exports = function(homebridge) {
    ({
        platformAccessory: PlatformAccessory,
        hap: {Characteristic, Service, AdaptiveLightingController, Categories, uuid: UUID}
    } = homebridge);

    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TuyaLan, true);
};

class TuyaLan {
    constructor(...props) {
        [this.log, this.config, this.api] = [...props];

        this.cachedAccessories = new Map();
        this._devices = new Map();
        this._shutdown = false;
        this.hap = {...this.api.hap,
            EnergyCharacteristics: require('./lib/EnergyCharacteristics')(this.api.hap)};

        if(!this.config || !this.config.devices) {
            this.log("No devices found. Check that you have specified them in your config.json file.");
            return false;
        }

        this._expectedUUIDs = this.config.devices.map(device => UUID.generate(PLUGIN_NAME +(device.fake ? ':fake:' : ':') + device.id));

        this.api.once('shutdown', this.shutdown.bind(this));
        this.api.once('didFinishLaunching', () => {
            this.discoverDevices();
        });
    }

    discoverDevices() {
        if (this._discoveryStarted || this._shutdown) return;
        this._discoveryStarted = true;
        const devices = new Map();
        const disabledIds = new Set();
        for (const configured of this.config.devices) {
            if (configured.disabled) {
                disabledIds.add(configured.id);
                continue;
            }
            const device = {...configured};
            device.id = String(device.id || '').trim();
            device.type = String(device.type || '').trim();
            device.ip = String(device.ip || '').trim();
            if (!device.id || !CLASS_DEF[device.type.toLowerCase()]) {
                this.log.warn('Skipping a device with missing ID or unsupported type.');
                continue;
            }
            if (!device.fake && ((typeof device.key !== 'string' && !Buffer.isBuffer(device.key)) || Buffer.byteLength(device.key) !== 16)) {
                this.log.warn('Skipping %s: a 16-byte local key is required.', device.name || device.id);
                continue;
            }
            if (device.fake) this._connectDevice(device);
            else devices.set(device.id, device);
        }

        const discovered = ({id, ip, version}) => {
            if (this._shutdown || typeof id !== 'string' || isIP(ip) !== 4) return;
            if (disabledIds.has(id)) return;
            const configured = devices.get(id);
            if (!configured) {
                this.log.info('Found unconfigured Tuya device %s at %s (protocol %s). Add its local key and device type to configure it.', id, ip, version || 'unknown');
                return;
            }
            const existing = this._devices.get(id);
            if (existing) {
                if (existing.updateIP(ip)) this.log.info('Updated local address for %s to %s.', configured.name || id, ip);
                return;
            }
            const protocol = ['3.1', '3.2', '3.3', '3.4', '3.5'].includes(version) ? version : configured.version;
            this._connectDevice({...configured, ip, ...(protocol ? {version: protocol} : {})});
        };
        this._onDiscovery = discovered;
        this._onIpChanged = ({id, newIp, version}) => discovered({id, ip: newIp, version});
        TuyaDiscovery.on('discover', this._onDiscovery);
        TuyaDiscovery.on('ipChanged', this._onIpChanged);
        TuyaDiscovery.start({ids: [...devices.keys()], log: this.log});

        this._discoveryFallback = setTimeout(() => {
            if (this._shutdown) return;
            for (const device of devices.values()) {
                if (this._devices.has(device.id)) continue;
                if (device.ip && isIP(device.ip) === 4) this._connectDevice(device);
                else this.log.info('Still looking for %s on the local network.', device.name || device.id);
            }
        }, 60000);
    }

    _connectDevice(config) {
        if (this._shutdown || this._devices.has(config.id)) return;
        const device = new TuyaAccessory({
            name: config.id.slice(8), ...config, log: this.log,
            UUID: UUID.generate(PLUGIN_NAME + (config.fake ? ':fake:' : ':') + config.id),
            connect: false
        });
        this._devices.set(config.id, device);
        this.addAccessory(device);
    }

    shutdown() {
        if (this._shutdown) return;
        this._shutdown = true;
        clearTimeout(this._discoveryFallback);
        if (this._onDiscovery) TuyaDiscovery.removeListener('discover', this._onDiscovery);
        if (this._onIpChanged) TuyaDiscovery.removeListener('ipChanged', this._onIpChanged);
        if (this._discoveryStarted) TuyaDiscovery.stop();
        for (const device of this._devices.values()) device.disconnect();
        this._devices.clear();
    }

    registerPlatformAccessories(platformAccessories) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, Array.isArray(platformAccessories) ? platformAccessories : [platformAccessories]);
    }

    configureAccessory(accessory) {
        // also checks null objects or empty config - this._expectedUUIDs
        if (accessory instanceof PlatformAccessory && this._expectedUUIDs && this._expectedUUIDs.includes(accessory.UUID)) {
            this.cachedAccessories.set(accessory.UUID, accessory);
            accessory.services.forEach(service => {
                if (service.UUID === Service.AccessoryInformation.UUID) return;
                service.characteristics.some(characteristic => {
                    if (!characteristic.props ||
                        !Array.isArray(characteristic.props.perms) ||
                        !(characteristic.props.perms.includes(this.hap.Perms.PAIRED_WRITE) && characteristic.props.perms.includes(this.hap.Perms.NOTIFY))
                    ) return;

                    this.log.info('Marked %s unreachable by faulting Service.%s.%s', accessory.displayName, service.displayName, characteristic.displayName);

                    characteristic.updateValue(new Error('Unreachable'));
                    return true;
                });
            });
        } else {
            /*
             * Irrespective of this unregistering, Homebridge continues
             * to "_prepareAssociatedHAPAccessory" and "addBridgedAccessory".
             * This timeout will hopefully remove the accessory after that has happened.
             */
            setTimeout(() => {
                this.removeAccessory(accessory);
            }, 1000);
        }
    }

    addAccessory(device) {
        const deviceConfig = device.context;
        const type = (deviceConfig.type || '').toLowerCase();

        const Accessory = CLASS_DEF[type];

        let accessory = this.cachedAccessories.get(deviceConfig.UUID),
            isCached = true;

        if (accessory && accessory.category !== Accessory.getCategory(Categories)) {
            this.log.info("%s has a different type (%s vs %s)", accessory.displayName, accessory.category, Accessory.getCategory(Categories));
            this.removeAccessory(accessory);
            accessory = null;
        }

        if (!accessory) {
            accessory = new PlatformAccessory(deviceConfig.name, deviceConfig.UUID, Accessory.getCategory(Categories));
            accessory.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Manufacturer, deviceConfig.manufacturer || "Unknown")
                .setCharacteristic(Characteristic.Model, deviceConfig.model || "Unknown")
                .setCharacteristic(Characteristic.SerialNumber, deviceConfig.id.slice(8));

            isCached = false;
        }

        if (accessory && accessory.displayName !== deviceConfig.name) {
            this.log.info(
                "Configuration name %s differs from cached displayName %s. Updating cached displayName to %s ",
                deviceConfig.name, accessory.displayName, deviceConfig.name);
            accessory.displayName = deviceConfig.name;
        }

        // Check if IP of accessory changed ( due to accessory reboots or power outage )
        if (accessory && String(accessory.ip) !== String(deviceConfig.ip)) {
            this.log.info("Accessory IP changed from %s to %s", String(accessory.ip), String(deviceConfig.ip));
        }

        this.cachedAccessories.set(deviceConfig.UUID, new Accessory(this, accessory, device, !isCached));
    }

    removeAccessory(homebridgeAccessory) {
        if (!homebridgeAccessory) return;

        this.log.warn('Unregistering', homebridgeAccessory.displayName);

        delete this.cachedAccessories[homebridgeAccessory.UUID];
        this.api.unregisterPlatformAccessories(PLATFORM_NAME, PLATFORM_NAME, [homebridgeAccessory]);
    }

    removeAccessoryByUUID(uuid) {
        if (uuid) this.removeAccessory(this.cachedAccessories.get(uuid));
    }
}
