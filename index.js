const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const PLUGIN_NAME = 'homebridge-heatingmat';
const ACCESSORY_NAME = 'Heating Mat';

const CONFIG = {
    WRITE_DELAY_MS: 250,
    CONNECT_TIMEOUT_MS: 20000,
    SCAN_INTERVAL_MS: 8000,
    RECONNECT_BASE_DELAY_MS: 3000,
    RECONNECT_MAX_DELAY_MS: 60000,

    MIN_TEMP: 36,
    MAX_TEMP: 42,
    DEFAULT_TEMP: 38,

    TEMP_LEVEL_MAP: { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 },
    LEVEL_TEMP_MAP: { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 },
    BRIGHTNESS_PER_HOUR: 100 / 12,
};

function createPacket(value) {
    const v = value & 0xff;
    const c = (0xff - v) & 0xff;
    return Buffer.from([v, c, v, c]);
}

function parsePacket(buf) {
    if (!buf || buf.length < 4) return null;
    return buf.readUInt8(3);
}

class BleController {
    constructor(log, config) {
        this.log = log;
        this.mac = config.mac_address.toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = config.service_uuid.toLowerCase();
        this.tempUuid = config.char_temp_uuid.toLowerCase();
        this.timerUuid = config.char_timer_uuid.toLowerCase();
        this.setUuid = config.char_set_uuid?.toLowerCase();
        this.initPacket = config.init_packet_hex;

        this.device = null;
        this.adapter = null;
        this.connected = false;
        this.connecting = false;
        this.retry = 0;
    }

    async init() {
        const { bluetooth } = NodeBle.createBluetooth();
        this.adapter = await bluetooth.defaultAdapter();
        this.scanLoop();
    }

    async scanLoop() {
        while (true) {
            if (this.connected || this.connecting) {
                await sleep(3000);
                continue;
            }

            try {
                await this.adapter.startDiscovery();
                await sleep(3000);
                const devices = await this.adapter.devices();
                for (const addr of devices) {
                    const norm = addr.replace(/:/g, '').toLowerCase();
                    if (norm === this.mac) {
                        this.device = await this.adapter.getDevice(addr);
                        await this.adapter.stopDiscovery();
                        await this.connect();
                        break;
                    }
                }
                await this.adapter.stopDiscovery();
            } catch (e) {
                this.log.warn('[BLE] scan error:', e.message);
            }

            await sleep(CONFIG.SCAN_INTERVAL_MS);
        }
    }

    async connect() {
        if (!this.device || this.connected || this.connecting) return;

        this.connecting = true;
        try {
            await Promise.race([
                this.device.connect(),
                sleep(CONFIG.CONNECT_TIMEOUT_MS).then(() => {
                    throw new Error('connect timeout');
                }),
            ]);

            this.connected = true;
            this.retry = 0;
            this.log.info('[BLE] connected');

            this.device.on('disconnect', () => {
                this.log.warn('[BLE] disconnected');
                this.connected = false;
                this.connecting = false;
            });

            await this.discover();
        } catch (e) {
            this.connected = false;
            this.connecting = false;
            this.retry++;
            const delay = Math.min(
                CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.retry),
                CONFIG.RECONNECT_MAX_DELAY_MS,
            );
            this.log.warn(`[BLE] reconnect in ${delay}ms`);
            await sleep(delay);
        }
    }

    async discover() {
        const gatt = await this.device.gatt();
        const service = await gatt.getPrimaryService(this.serviceUuid);

        this.tempChar = await service.getCharacteristic(this.tempUuid);
        this.timerChar = await service.getCharacteristic(this.timerUuid);

        if (this.setUuid) {
            this.setChar = await service.getCharacteristic(this.setUuid);
            await this.write(this.setChar, Buffer.from(this.initPacket, 'hex'));
        }

        await this.tempChar.startNotifications();
        await this.timerChar.startNotifications();
    }

    async write(char, data) {
        if (!this.connected) return false;
        try {
            await char.writeValue(data, { type: 'command' });
            await sleep(CONFIG.WRITE_DELAY_MS);
            return true;
        } catch {
            return false;
        }
    }
}

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.name = config.name || 'Heating Mat';

        this.state = {
            temp: CONFIG.DEFAULT_TEMP,
            heating: false,
            timerHours: 0,
        };

        this.ble = new BleController(log, config);
        this.ble.init();

        this.initServices();
    }

    initServices() {
        this.infoService = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'SOLZAM')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, 'HM-' + Date.now());

        this.thermostatService = new this.Service.Thermostat(
            this.name,
            'thermostat',
        );

        this.thermostatService
            .getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: 36, maxValue: 42, minStep: 1 })
            .onSet(this.setTemp.bind(this))
            .onGet(() => this.state.temp);

        this.thermostatService
            .getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(() => this.state.temp);

        this.thermostatService
            .getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .onSet(this.setPower.bind(this))
            .onGet(() => (this.state.heating ? 1 : 0));

        this.timerService = new this.Service.Lightbulb(
            this.name + ' Timer',
            'timer',
        );

        this.timerService
            .getCharacteristic(this.Characteristic.On)
            .onSet(v => this.setTimer(v ? this.state.timerHours || 1 : 0))
            .onGet(() => this.state.timerHours > 0);

        this.timerService
            .getCharacteristic(this.Characteristic.Brightness)
            .onSet(v => this.setTimer(Math.round(v / CONFIG.BRIGHTNESS_PER_HOUR)))
            .onGet(() => this.state.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    getServices() {
        return [
            this.infoService,
            this.thermostatService,
            this.timerService,
        ];
    }

    async setTemp(v) {
        const level = CONFIG.TEMP_LEVEL_MAP[v] || 0;
        if (await this.ble.write(this.ble.tempChar, createPacket(level))) {
            this.state.temp = v;
        }
    }

    async setPower(v) {
        if (v === 0) {
            await this.ble.write(this.ble.tempChar, createPacket(0));
            this.state.heating = false;
        } else {
            await this.setTemp(this.state.temp);
            this.state.heating = true;
        }
    }

    async setTimer(h) {
        this.state.timerHours = h;
        const pkt = h === 0 ? Buffer.from([0, 0xff, 0, 0xff]) : createPacket(h);
        await this.ble.write(this.ble.timerChar, pkt);
    }
}

module.exports = api => {
    api.registerAccessory(
        PLUGIN_NAME,
        ACCESSORY_NAME,
        HeatingMatAccessory,
    );
};
