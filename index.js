const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    WRITE_DELAY_MS: 300,
    RETRY_COUNT: 3,
    RECONNECT_DELAY: 5000,
    CONNECT_TIMEOUT: 30000,
    HEALTH_CHECK_INTERVAL: 30000,
    TEMP_LEVEL_MAP: { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 },
    LEVEL_TEMP_MAP: { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 },
    MIN_TEMP: 36,
    MAX_TEMP: 42,
    DEFAULT_HEAT_TEMP: 38,
    BRIGHTNESS_PER_HOUR: 100 / 12,
};

function createControlPacket(value) {
    const d = value & 0xff;
    const c = (0xff - d) & 0xff;
    return Buffer.from([d, c, d, c]);
}

function parsePacket(buffer) {
    if (!buffer || buffer.length < 4) return 255;
    return buffer.readUInt8(3);
}

class BleManager {
    constructor(log, config) {
        this.log = log;
        this.macAddress = config.mac_address.toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = config.service_uuid.toLowerCase();
        this.charTempUuid = config.char_temp_uuid.toLowerCase();
        this.charTimeUuid = config.char_timer_uuid.toLowerCase();
        this.charSetUuid = config.char_set_uuid?.toLowerCase();
        this.initPacketHex = config.init_packet_hex;
        this.isDeviceConnected = false;
        this.stopped = false;
    }

    async initialize() {
        const { bluetooth } = NodeBle.createBluetooth();
        return bluetooth.defaultAdapter();
    }

    async startScanning(adapter, onFound) {
        while (!this.stopped) {
            if (this.isDeviceConnected) {
                await sleep(10000);
                continue;
            }
            try {
                await adapter.startDiscovery();
                await sleep(3000);
                await adapter.stopDiscovery();

                for (const addr of await adapter.devices()) {
                    if (addr.replace(/:/g, '').toLowerCase() === this.macAddress) {
                        const device = await adapter.getDevice(addr);
                        if (!this.isDeviceConnected) await onFound(device);
                        break;
                    }
                }
            } catch (e) {
                this.log.error('[BLE] Scan error:', e.message);
            }
            await sleep(5000);
        }
    }
}

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;

        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        this.ble = new BleManager(log, config);
        this.device = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.healthTimer = null;
        this.setTempTimeout = null;

        this.state = {
            targetTemp: CONFIG.DEFAULT_HEAT_TEMP,
            currentTemp: CONFIG.DEFAULT_HEAT_TEMP,
            heating: 0,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: CONFIG.DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initBle();
        this.startHealthCheck();

        api.on('shutdown', () => this.cleanup());
    }

    initServices() {
        this.info = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Homebridge')
            .setCharacteristic(this.Characteristic.Model, 'Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.config.mac_address);

        this.thermostat = new this.Service.Thermostat(this.config.name);
        this.timer = new this.Service.Lightbulb(this.config.name + ' 타이머');

        this.thermostat.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: CONFIG.MIN_TEMP, maxValue: CONFIG.MAX_TEMP, minStep: 1 })
            .onGet(() => this.state.targetTemp)
            .onSet(v => this.handleSetTargetTemperature(v));

        this.thermostat.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(() => this.state.currentTemp);

        this.thermostat.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(() => this.state.heating)
            .onSet(v => this.handleSetHeating(v));

        this.timer.getCharacteristic(this.Characteristic.On)
            .onGet(() => this.state.timerOn)
            .onSet(v => this.handleTimerSwitch(v));

        this.timer.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: CONFIG.BRIGHTNESS_PER_HOUR })
            .onGet(() => this.state.timerHours * CONFIG.BRIGHTNESS_PER_HOUR)
            .onSet(v => this.handleSetTimerHours(v));

        this.services = [this.info, this.thermostat, this.timer];
    }

    getServices() {
        return this.services;
    }

    async initBle() {
        const adapter = await this.ble.initialize();
        this.ble.startScanning(adapter, d => {
            this.device = d;
            this.connect();
        });
    }

    async connect() {
        if (this.isConnected) return;

        try {
            await Promise.race([
                this.device.connect(),
                new Promise((_, r) => setTimeout(() => r(new Error('timeout')), CONFIG.CONNECT_TIMEOUT))
            ]);

            this.isConnected = true;
            this.ble.isDeviceConnected = true;
            this.reconnectAttempts = 0;

            this.device.removeAllListeners('disconnect');
            this.device.on('disconnect', async () => {
                this.isConnected = false;
                this.ble.isDeviceConnected = false;
                await sleep(CONFIG.RECONNECT_DELAY);
            });

            await this.discover();
            this.log.info('Heating Mat connected');
        } catch (e) {
            this.log.error('BLE connect failed:', e.message);
        }
    }

    async discover() {
        const gatt = await this.device.gatt();
        const service = await gatt.getPrimaryService(this.ble.serviceUuid);

        this.tempChar = await service.getCharacteristic(this.ble.charTempUuid);
        this.timeChar = await service.getCharacteristic(this.ble.charTimeUuid);

        if (this.ble.charSetUuid) {
            const setChar = await service.getCharacteristic(this.ble.charSetUuid);
            await setChar.writeValue(Buffer.from(this.ble.initPacketHex, 'hex'));
        }

        await this.tempChar.startNotifications();
        this.tempChar.on('valuechanged', d => this.handleUpdate(d, 'temp'));

        await this.timeChar.startNotifications();
        this.timeChar.on('valuechanged', d => this.handleUpdate(d, 'timer'));
    }

    async write(char, packet) {
        if (!this.isConnected) return false;
        for (let i = 0; i < CONFIG.RETRY_COUNT; i++) {
            try {
                await char.writeValue(packet, { type: 'command' });
                await sleep(CONFIG.WRITE_DELAY_MS);
                return true;
            } catch {
                await sleep(CONFIG.WRITE_DELAY_MS);
            }
        }
        return false;
    }

    handleUpdate(data, type) {
        const v = parsePacket(data);
        if (v === 255) return;

        if (type === 'temp') {
            const t = CONFIG.LEVEL_TEMP_MAP[v];
            if (t !== undefined) {
                this.state.targetTemp = t;
                this.state.currentTemp = t;
                this.state.heating = v > 0 ? 1 : 0;
                if (v > 0) this.state.lastHeatTemp = t;
            }
        } else {
            this.state.timerHours = v;
            this.state.timerOn = v > 0;
        }
        this.syncHomeKit();
    }

    syncHomeKit() {
        this.thermostat.updateCharacteristic(this.Characteristic.TargetTemperature, this.state.targetTemp);
        this.thermostat.updateCharacteristic(this.Characteristic.CurrentTemperature, this.state.currentTemp);
        this.thermostat.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.state.heating);
        this.timer.updateCharacteristic(this.Characteristic.On, this.state.timerOn);
        this.timer.updateCharacteristic(this.Characteristic.Brightness, this.state.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetHeating(v) {
        const level = v ? CONFIG.TEMP_LEVEL_MAP[this.state.lastHeatTemp] : 0;
        if (await this.write(this.tempChar, createControlPacket(level))) {
            this.state.heating = v;
            this.syncHomeKit();
        }
    }

    async handleSetTargetTemperature(v) {
        this.state.targetTemp = v;
        clearTimeout(this.setTempTimeout);

        this.setTempTimeout = setTimeout(async () => {
            const lvl = CONFIG.TEMP_LEVEL_MAP[v];
            if (await this.write(this.tempChar, createControlPacket(lvl))) {
                this.state.lastHeatTemp = v;
            }
        }, 500);
    }

    async handleTimerSwitch(v) {
        const h = v ? Math.max(1, this.state.timerHours) : 0;
        await this.handleSetTimerHours(h * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTimerHours(v) {
        const h = Math.round(v / CONFIG.BRIGHTNESS_PER_HOUR);
        this.state.timerHours = h;
        this.state.timerOn = h > 0;

        const pkt = h === 0 ? Buffer.from([0, 255, 0, 255]) : createControlPacket(h);
        if (await this.write(this.timeChar, pkt)) this.syncHomeKit();
    }

    startHealthCheck() {
        this.healthTimer = setInterval(async () => {
            if (this.isConnected && this.tempChar) {
                try {
                    await this.tempChar.readValue();
                } catch {
                    this.isConnected = false;
                }
            }
        }, CONFIG.HEALTH_CHECK_INTERVAL);
    }

    cleanup() {
        clearInterval(this.healthTimer);
        clearTimeout(this.setTempTimeout);
        this.ble.stopped = true;
    }
}

module.exports = (api) => {
    api.registerAccessory(
        'homebridge-heatingmat',
        'HeatingMatAccessory',
        HeatingMatAccessory
    );
};
