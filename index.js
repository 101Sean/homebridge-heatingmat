const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Constant
const CONFIG = {
    WRITE_DELAY_MS: 300,
    KEEP_ALIVE_INTERVAL_MS: 10000,
    KEEP_ALIVE_INITIAL_DELAY_MS: 3000,
    TEMP_LEVEL_MAP: { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 },
    LEVEL_TEMP_MAP: { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 },
    MIN_TEMP: 36,
    MAX_TEMP: 42,
    DEFAULT_HEAT_TEMP: 38,
    MAX_TIMER_HOURS: 12,
    BRIGHTNESS_PER_HOUR: 100 / 12,
};

const PLUGIN_NAME = 'homebridge-heatingmat';
const PLATFORM_NAME = 'Heating Mat Platform';


// Packet
function createControlPacket(value) {
    const dataByte = value;
    const checkSum = (0xFF - dataByte) & 0xFF;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(dataByte, 0);
    buffer.writeUInt8(checkSum, 1);
    buffer.writeUInt8(dataByte, 2);
    buffer.writeUInt8(checkSum, 3);
    return buffer;
}

function parsePacket(buffer) {
    if (!buffer || buffer.length < 4) {
        if (buffer.length >= 1) {
            const val = buffer.readUInt8(0);
            return (val > 12 && val < 255) ? (255 - val) : val;
        }
        return 255;
    }
    return buffer.readUInt8(3); // Target Value
}


// BLE
class BleManager {
    constructor(log, config) {
        this.log = log;
        this.macAddress = config.mac_address?.toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = config.service_uuid?.toLowerCase();
        this.charTempUuid = config.char_temp_uuid?.toLowerCase();
        this.charTimeUuid = config.char_timer_uuid?.toLowerCase();
        this.charSetUuid = config.char_set_uuid?.toLowerCase();
        this.initPacketHex = config.init_packet_hex;
        this.isDeviceConnected = false;
    }

    async initialize() {
        const { bluetooth } = NodeBle.createBluetooth();
        return await bluetooth.defaultAdapter();
    }

    async startScanningLoop(adapter, onDeviceFound) {
        while (true) {
            if (this.isDeviceConnected) {
                await sleep(10000);
                continue;
            }
            try {
                await adapter.startDiscovery();
                await sleep(3000);
                await adapter.stopDiscovery();
                const devices = await adapter.devices();
                for (const addr of devices) {
                    const normalized = addr.toUpperCase().replace(/:/g, '').toLowerCase();
                    if (normalized === this.macAddress) {
                        const device = await adapter.getDevice(addr);
                        if (!this.isDeviceConnected) await onDeviceFound(device);
                        break;
                    }
                }
            } catch (error) { this.log.error(`[BLE] 스캔 오류: ${error.message}`); }
            await sleep(5000);
        }
    }
}


// HB Platform
class HeatingMatPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.config = config || {};
        this.accessories = [];

        this.api.on('didFinishLaunching', () => {
            this.log.info('Heating Mat 플랫폼 로딩 완료');
            this.setupDevices();
        });
    }

    configureAccessory(accessory) {
        this.log.info('캐시 복구 기기:', accessory.displayName);
        this.accessories.push(accessory);
    }

    setupDevices() {
        if (!this.config.devices || !Array.isArray(this.config.devices)) {
            this.log.warn('config.json에 기기 설정이 없습니다.');
            return;
        }

        for (const deviceConfig of this.config.devices) {
            const uuid = this.api.hap.uuid.generate('hb:heatmat:' + deviceConfig.mac_address);
            const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

            if (existingAccessory) {
                new HeatingMatDevice(this.log, deviceConfig, this.api, existingAccessory);
            } else {
                const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
                new HeatingMatDevice(this.log, deviceConfig, this.api, accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        }
    }
}


// Accessory
class HeatingMatDevice {
    constructor(log, config, api, accessory) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessory = accessory;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        this.bleManager = new BleManager(log, config);
        this.isConnected = false;
        this.device = null;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        this.keepAliveTimer = null;
        this.keepAliveInterval = null;
        this.setTempTimeout = null;
        this.lastSentLevel = -1;

        this.currentState = {
            targetTemp: 0,
            currentTemp: CONFIG.MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: CONFIG.DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initBle();
    }

    initServices() {
        const info = this.accessory.getService(this.Service.AccessoryInformation) ||
            this.accessory.addService(this.Service.AccessoryInformation);
        info.setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.config.mac_address);

        this.thermostat = this.accessory.getService(this.Service.Thermostat) ||
            this.accessory.addService(this.Service.Thermostat, this.config.name);

        this.thermostat.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: CONFIG.MIN_TEMP, maxValue: CONFIG.MAX_TEMP, minStep: 1 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        this.thermostat.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(() => this.currentState.currentTemp);

        this.thermostat.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] }) // OFF, HEAT
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => this.currentState.currentHeatingCoolingState === 0 ? 0 : 1);

        this.thermostat.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);


        this.timer = this.accessory.getService(this.Service.Lightbulb) ||
            this.accessory.addService(this.Service.Lightbulb, this.config.name + ' 타이머');

        this.timer.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timer.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: CONFIG.BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async initBle() {
        try {
            const adapter = await this.bleManager.initialize();
            await this.bleManager.startScanningLoop(adapter, async (device) => {
                this.device = device;
                await this.connectDevice();
            });
        } catch (e) { this.log.error(`[${this.config.name}] BLE 초기화 실패`); }
    }

    async connectDevice() {
        if (this.isConnected) return;
        try {
            this.log.info(`[${this.config.name}] 블루투스 연결 시도...`);
            await this.device.connect();
            await sleep(2000);
            this.isConnected = true;
            this.bleManager.isDeviceConnected = true;
            this.device.on('disconnect', () => {
                this.log.warn(`[${this.config.name}] 연결 끊김. 재검색 시작.`);
                this.disconnect(true);
            });
            await this.discover();
        } catch (e) { this.log.error("연결 실패"); this.disconnect(true); }
    }

    async discover() {
        try {
            const gatt = await this.device.gatt();
            const service = await gatt.getPrimaryService(this.bleManager.serviceUuid);
            this.tempCharacteristic = await service.getCharacteristic(this.bleManager.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.bleManager.charTimeUuid);

            if (this.bleManager.charSetUuid) {
                this.setCharacteristic = await service.getCharacteristic(this.bleManager.charSetUuid);
                await this.sendInitPacket();
            }

            await this.tempCharacteristic.startNotifications();
            this.tempCharacteristic.on('valuechanged', (data) => this.handleNotification(data, 'temp'));
            await this.timeCharacteristic.startNotifications();
            this.timeCharacteristic.on('valuechanged', (data) => this.handleNotification(data, 'timer'));

            this.log.info(`[${this.config.name}] 모든 준비 완료`);
            this.startKeepAlive();
            await this.syncState();
        } catch (e) { this.log.error("특성 탐색 실패"); this.disconnect(true); }
    }

    async syncState() {
        if (!this.isConnected) return;
        try {
            const tBuf = await this.tempCharacteristic.readValue();
            const tLvl = parsePacket(tBuf);
            const tVal = CONFIG.LEVEL_TEMP_MAP[tLvl] || 0;

            const bBuf = await this.timeCharacteristic.readValue();
            const bVal = parsePacket(bBuf);

            this.currentState.targetTemp = tVal;
            this.currentState.currentTemp = tVal;
            this.currentState.currentHeatingCoolingState = tLvl > 0 ? 1 : 0;
            this.currentState.timerHours = bVal;
            this.currentState.timerOn = bVal > 0;
            if (tLvl > 0) this.currentState.lastHeatTemp = tVal;

            this.updateHK();
        } catch (e) { this.log.error("상태 동기화 실패"); }
    }

    updateHK() {
        this.thermostat.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
        this.thermostat.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
        this.thermostat.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
        this.timer.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timer.updateCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    handleNotification(data, type) {
        const val = parsePacket(data);
        if (val === 0 || val === 255) return;
        if (type === 'temp') {
            const t = CONFIG.LEVEL_TEMP_MAP[val];
            if (t) {
                this.currentState.targetTemp = t;
                this.currentState.currentTemp = t;
                this.currentState.currentHeatingCoolingState = 1;
                this.currentState.lastHeatTemp = t;
                this.updateHK();
            }
        } else {
            this.currentState.timerHours = val;
            this.currentState.timerOn = val > 0;
            this.updateHK();
        }
    }

    async write(char, pkt) {
        if (!this.isConnected || !char) return;
        try { await char.writeValue(pkt, { type: 'command' }); await sleep(CONFIG.WRITE_DELAY_MS); } catch (e) { this.log.error("Write 실패"); }
    }

    async sendInitPacket(isKA = false) {
        if (!this.isConnected || !this.setCharacteristic) return;
        try { await this.setCharacteristic.writeValue(Buffer.from(this.bleManager.initPacketHex, 'hex'), { type: 'command' }); } catch (e) {}
    }

    startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            if (this.isConnected) this.sendInitPacket(true);
        }, CONFIG.KEEP_ALIVE_INTERVAL_MS);
    }

    stopKeepAlive() { if (this.keepAliveInterval) clearInterval(this.keepAliveInterval); }

    disconnect(reset = false) {
        this.stopKeepAlive();
        this.isConnected = false;
        this.bleManager.isDeviceConnected = false;
        if (reset) this.device = null;
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === 0) { // OFF
            await this.handleSetTargetTemperature(36);
            setTimeout(async () => {
                await this.write(this.timeCharacteristic, Buffer.from([0x00, 0xff, 0x00, 0xff]));
                this.currentState.timerOn = false;
                this.currentState.timerHours = 0;
                this.updateHK();
            }, 500);
            this.currentState.currentHeatingCoolingState = 0;
        } else { // HEAT
            this.handleSetTargetTemperature(this.currentState.lastHeatTemp || 38);
            this.currentState.currentHeatingCoolingState = 1;
        }
    }

    async handleSetTargetTemperature(v) {
        let level = v <= 35 ? 0 : (v > 42 ? 7 : v - 35);
        this.currentState.targetTemp = v <= 35 ? 36 : v;
        this.updateHK();

        if (this.setTempTimeout) clearTimeout(this.setTempTimeout);
        this.setTempTimeout = setTimeout(async () => {
            await this.write(this.tempCharacteristic, createControlPacket(level));
            if (level > 0) this.currentState.lastHeatTemp = this.currentState.targetTemp;
        }, 350);
    }

    async handleTimerSwitch(v) {
        const h = v ? Math.max(1, this.currentState.timerHours) : 0;
        await this.handleSetTimerHours(h * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTimerHours(v) {
        const h = Math.round(v / CONFIG.BRIGHTNESS_PER_HOUR);
        this.currentState.timerHours = h;
        this.currentState.timerOn = h > 0;
        const pkt = h === 0 ? Buffer.from([0x00, 0xff, 0x00, 0xff]) : createControlPacket(h);
        await this.write(this.timeCharacteristic, pkt);
        this.updateHK();
    }
}

module.exports = (api) => {
    api.registerPlatform(PLATFORM_NAME, HeatingMatPlatform);
};