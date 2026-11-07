const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');
const net = require('net');
const os = require('os');

const UDP_KEY = Buffer.from('6c1ec8e2bb9bb59ab50b0daf649b410a', 'hex');
const UDP_V35_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const PORTS = [6666, 6667, 7000];
const MAX_PACKET_SIZE = 8192;
const MAX_UNKNOWN_DEVICES = 256;

class TuyaDiscovery extends EventEmitter {
  constructor() {
    super();
    this.discovered = new Map();
    this.limitedIds = [];
    this._servers = {};
    this._retries = new Map();
    this._probeTimer = null;
    this._running = false;
  }

  start(props = {}) {
    this.log = props.log || this.log;
    this.limitedIds = Array.isArray(props.ids) ? props.ids.filter(id => typeof id === 'string') : [];
    if (props.clear) this.discovered.clear();
    if (this._running) return this;
    this._running = true;
    for (const port of PORTS) this._start(port);
    return this;
  }

  stop() {
    this._running = false;
    clearInterval(this._probeTimer);
    this._probeTimer = null;
    for (const timer of this._retries.values()) clearTimeout(timer);
    this._retries.clear();
    for (const port of PORTS) this._stop(port);
    return this;
  }

  end() {
    this.stop();
    this.discovered.clear();
    this.emit('end');
    this.removeAllListeners();
    return this;
  }

  _start(port) {
    if (!this._running) return;
    this._stop(port);
    const server = this._servers[port] = dgram.createSocket({type: 'udp4', reuseAddr: true});
    server.on('error', err => {
      if (this._servers[port] !== server) return;
      this._stop(port);
      if (!this._running) return;
      this.log.warn(`Discovery - Port ${port} failed${err.code === 'EADDRINUSE' ? ' (in use)' : ''}.`);
      this._retry(port, 15000);
    });
    server.on('close', () => {
      if (this._servers[port] !== server) return;
      this._stop(port);
      this._retry(port, 1000);
    });
    server.on('message', (msg, info) => this._onDgramMessage(port, msg, info));
    server.on('listening', () => {
      if (!this._running || this._servers[port] !== server) return;
      this.log.info(`Discovery - Discovery started on port ${port}.`);
      if (port === 7000) {
        try {
          server.setBroadcast(true);
        } catch (_) {
          this.log.warn('Discovery - Could not enable LAN broadcasts.');
          return;
        }
        this.sendClientBroadcast();
        this._probeTimer = setInterval(() => this.sendClientBroadcast(), 60000);
        this._probeTimer.unref();
      }
    });
    server.bind(port);
  }

  _retry(port, delay) {
    if (!this._running || this._retries.has(port)) return;
    const timer = setTimeout(() => {
      this._retries.delete(port);
      if (this._running) this._start(port);
    }, delay);
    timer.unref();
    this._retries.set(port, timer);
  }

  _stop(port) {
    const server = this._servers[port];
    if (port === 7000) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
    if (!server) return;
    this._servers[port] = null;
    server.removeAllListeners();
    // A pending bind/send can report an asynchronous error during shutdown.
    // Keep only an inert error handler until the socket has actually closed.
    server.on('error', () => {});
    server.once('close', () => server.removeAllListeners());
    try { server.close(); } catch (_) { server.removeAllListeners(); }
  }

  _onDgramMessage(port, msg, info) {
    // UDP is untrusted. Reject incomplete or oversized frames before any reads.
    if (!Buffer.isBuffer(msg) || msg.length < 4 || msg.length > MAX_PACKET_SIZE || !info || !net.isIPv4(info.address)) return;
    const prefix = msg.readUInt32BE(0);
    if (prefix === 0x6699) {
      this._handleV35Message(msg, info);
      return;
    }
    if (prefix !== 0x55aa || msg.length < 28 || msg.readUInt32BE(msg.length - 4) !== 0xaa55) return;
    const size = msg.readUInt32BE(12);
    if (size !== msg.length - 16 || size < 12) return;
    // Legacy devices prepend an unencrypted return code. Some older broadcasts
    // omit it; both layouts still have the length and footer checked above.
    const payloads = [msg.subarray(20, msg.length - 8), msg.subarray(16, msg.length - 8)];
    for (const payload of payloads) {
      let plaintext = payload;
      if (port === 6667) {
        try {
          const decipher = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
          plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
        } catch (_) { /* Preserve legacy plaintext broadcasts on this port. */ }
      }
      if (this._parseDiscovery(plaintext, info)) return;
    }
  }

  _handleV35Message(msg, info) {
    if (msg.length < 50 || msg.readUInt32BE(msg.length - 4) !== 0x9966 || msg.readUInt32BE(14) !== msg.length - 22) return;
    let plaintext;
    try {
      const decipher = crypto.createDecipheriv('aes-128-gcm', UDP_V35_KEY, msg.subarray(18, 30));
      decipher.setAAD(msg.subarray(4, 18));
      decipher.setAuthTag(msg.subarray(msg.length - 20, msg.length - 4));
      plaintext = Buffer.concat([decipher.update(msg.subarray(30, msg.length - 20)), decipher.final()]);
    } catch (_) {
      return;
    }
    // App probes have no return-code prefix. Parsing them yields no device ID,
    // so our own broadcasts and other clients' broadcasts are ignored silently.
    if (!this._parseDiscovery(plaintext, info) && plaintext.length >= 4) this._parseDiscovery(plaintext.subarray(4), info);
  }

  _parseDiscovery(payload, info) {
    let data;
    try { data = JSON.parse(payload.toString('utf8')); } catch (_) { return false; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const id = data.gwId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof data.ip !== 'string' || !net.isIPv4(data.ip) || data.ip !== info.address) return false;
    if (data.version !== undefined && (typeof data.version !== 'string' || !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(data.version))) return false;
    const device = {id, ip: data.ip};
    if (data.version !== undefined) device.version = data.version;
    this._onDiscover(device);
    return true;
  }

  _onDiscover(device) {
    const previous = this.discovered.get(device.id);
    if (!previous && !this.limitedIds.includes(device.id)) {
      const unknown = [...this.discovered.keys()].filter(id => !this.limitedIds.includes(id));
      if (unknown.length >= MAX_UNKNOWN_DEVICES) this.discovered.delete(unknown[0]);
    }
    const data = {...device};
    if (data.version === undefined && previous && previous.version !== undefined) data.version = previous.version;
    this.discovered.set(data.id, data);
    if (!previous) this.emit('discover', {...data});
    else if (previous.ip !== data.ip) {
      const change = {id: data.id, oldIp: previous.ip, newIp: data.ip};
      if (data.version !== undefined) change.version = data.version;
      this.emit('ipChanged', change);
    }
  }

  sendClientBroadcast() {
    const server = this._servers[7000];
    if (!this._running || !server) return;
    const destinations = new Set();
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const iface of interfaces || []) {
        if ((iface.family !== 'IPv4' && iface.family !== 4) || iface.internal || !net.isIPv4(iface.address) || !net.isIPv4(iface.netmask)) continue;
        const address = iface.address.split('.').map(Number);
        const mask = iface.netmask.split('.').map(Number);
        const broadcast = address.map((octet, index) => (octet & mask[index]) | (~mask[index] & 255)).join('.');
        const destination = `${iface.address}/${broadcast}`;
        if (destinations.has(destination)) continue;
        destinations.add(destination);
        const payload = Buffer.from(JSON.stringify({from: 'app', ip: iface.address}));
        const iv = crypto.randomBytes(12);
        const header = Buffer.alloc(18);
        header.writeUInt32BE(0x6699);
        header.writeUInt32BE(1, 6);
        header.writeUInt32BE(0x25, 10); // REQ_DEVINFO: active device discovery.
        header.writeUInt32BE(12 + payload.length + 16, 14);
        const cipher = crypto.createCipheriv('aes-128-gcm', UDP_V35_KEY, iv);
        cipher.setAAD(header.subarray(4));
        const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
        const packet = Buffer.concat([header, iv, encrypted, cipher.getAuthTag(), Buffer.from('00009966', 'hex')]);
        try {
          server.send(packet, 7000, broadcast, err => {
            if (err && this._running && this._servers[7000] === server) this.log.warn('Discovery - Could not send LAN discovery probe.');
          });
        } catch (_) {
          if (this._running) this.log.warn('Discovery - Could not send LAN discovery probe.');
        }
      }
    }
  }
}

module.exports = new TuyaDiscovery();
module.exports.TuyaDiscovery = TuyaDiscovery;
