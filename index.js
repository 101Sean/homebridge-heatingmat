const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    WRITE_DELAY_MS: 300,
    RETRY_COUNT: 3,
    KEEP_ALIVE_INTERVAL: 10000,
    TEMP_LEVEL_MAP: { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 },
    LEVEL_TEMP_MAP: { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 },
    MIN_TEMP: 36,
    MAX_TEMP: 42,
    DEFAULT_HEAT_TEMP: 38,
    BRIGHTNESS_PER_HOUR: 100 / 12,
};

const PLUGIN_NAME = 'homebridge-heatingmat';
const PLATFORM_NAME = 'Heating Mat Platform';

function createControlPacket(value) {
    const dataByte = value & 0xFF;
    const checkSum = (0xFF - dataByte) & 0xFF;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(dataByte, 0);
    buffer.writeUInt8(checkSum, 1);
    buffer.writeUInt8(dataByte, 2);
    buffer.writeUInt8(checkSum, 3);
    return buffer;
}

function parsePacket(buffer) {
    if (!buffer || buffer.length < 4) return 255;
    return buffer.readUInt8(3);
}

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
        this.setTempTimeout = null;

        this.currentState = {
            targetTemp: CONFIG.DEFAULT_HEAT_TEMP,
            currentTemp: CONFIG.DEFAULT_HEAT_TEMP,
            currentHeatingCoolingState: 0,
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
        info.setCharacteristic(this.Characteristic.Manufacturer, 'Homebridge')
            .setCharacteristic(this.Characteristic.Model, 'Heating Mat')
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
            .setProps({ validValues: [0, 1] })
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
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
        } catch (e) { this.log.error(`[${this.config.name}] BLE 초기화 실패: ${e.message}`); }
    }

    async connectDevice() {
        if (this.isConnected) return;
        try {
            this.log.info(`[${this.config.name}] 매트 연결 시도...`);
            await this.device.connect();
            await sleep(2000);
            this.isConnected = true;
            this.bleManager.isDeviceConnected = true;

            this.device.on('disconnect', () => {
                this.log.warn(`[${this.config.name}] 연결 끊김. 재연결 대기.`);
                this.isConnected = false;
                this.bleManager.isDeviceConnected = false;
            });

            await this.discover();
        } catch (e) { this.log.error("연결 실패"); this.isConnected = false; }
    }

    async discover() {
        try {
            const gatt = await this.device.gatt();
            const service = await gatt.getPrimaryService(this.bleManager.serviceUuid);
            this.tempChar = await service.getCharacteristic(this.charTempUuid);
            this.timeChar = await service.getCharacteristic(this.charTimeUuid);

            if (this.bleManager.charSetUuid) {
                this.setChar = await service.getCharacteristic(this.bleManager.charSetUuid);
                await this.writeRaw(this.setChar, Buffer.from(this.bleManager.initPacketHex, 'hex'));
            }

            await this.tempChar.startNotifications();
            this.tempChar.on('valuechanged', (data) => this.handleUpdate(data, 'temp'));
            await this.timeChar.startNotifications();
            this.timeChar.on('valuechanged', (data) => this.handleUpdate(data, 'timer'));

            this.log.info(`[${this.config.name}] 앱 프로토콜 동기화 완료`);
        } catch (e) { this.log.error("서비스 탐색 실패"); }
    }

    async writeRaw(characteristic, packet) {
        if (!this.isConnected || !characteristic) return false;

        for (let i = 0; i < CONFIG.RETRY_COUNT; i++) {
            try {
                await characteristic.writeValue(packet, { type: 'command' });
                await sleep(CONFIG.WRITE_DELAY_MS);
                return true;
            } catch (e) {
                this.log.warn(`쓰기 실패 (재시도 ${i+1}/${CONFIG.RETRY_COUNT})`);
                await sleep(CONFIG.WRITE_DELAY_MS);
            }
        }
        return false;
    }

    handleUpdate(data, type) {
        const val = parsePacket(data);
        if (val === 255) return;

        if (type === 'temp') {
            const t = CONFIG.LEVEL_TEMP_MAP[val];
            if (t !== undefined) {
                this.currentState.targetTemp = t;
                this.currentState.currentTemp = t;
                this.currentState.currentHeatingCoolingState = val > 0 ? 1 : 0;
                if (val > 0) this.currentState.lastHeatTemp = t;
            }
        } else {
            this.currentState.timerHours = val;
            this.currentState.timerOn = val > 0;
        }
        this.updateHomeKit();
    }

    updateHomeKit() {
        this.thermostat.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
        this.thermostat.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
        this.thermostat.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
        this.timer.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timer.updateCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === 0) {
            await this.writeRaw(this.tempChar, createControlPacket(0));
            this.currentState.currentHeatingCoolingState = 0;
        } else {
            const level = CONFIG.TEMP_LEVEL_MAP[this.currentState.lastHeatTemp] || 3;
            await this.writeRaw(this.tempChar, createControlPacket(level));
            this.currentState.currentHeatingCoolingState = 1;
        }
        this.updateHomeKit();
    }

    async handleSetTargetTemperature(v) {
        this.currentState.targetTemp = v;
        if (this.setTempTimeout) clearTimeout(this.setTempTimeout);

        this.setTempTimeout = setTimeout(async () => {
            const level = CONFIG.TEMP_LEVEL_MAP[v] || 0;
            const success = await this.writeRaw(this.tempChar, createControlPacket(level));
            if (success && level > 0) this.currentState.lastHeatTemp = v;
        }, 500);
    }

    async handleTimerSwitch(v) {
        const h = v ? Math.max(1, this.currentState.timerHours) : 0;
        await this.handleSetTimerHours(h * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTimerHours(v) {
        const h = Math.round(v / CONFIG.BRIGHTNESS_PER_HOUR);
        this.currentState.timerHours = h;
        this.currentState.timerOn = h > 0;
        await this.writeRaw(this.timeChar, h === 0 ? Buffer.from([0x00, 0xff, 0x00, 0xff]) : createControlPacket(h));
        this.updateHomeKit();
    }
}


class HeatingMatPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.config = config || {};
        this.accessories = [];

        this.api.on('didFinishLaunching', () => {
            if (this.config.devices) {
                this.config.devices.forEach(device => this.addDevice(device));
            }
        });
    }

    configureAccessory(accessory) {
        this.accessories.push(accessory);
    }

    addDevice(deviceConfig) {
        const uuid = this.api.hap.uuid.generate('heating:mat:' + deviceConfig.mac_address);
        const existing = this.accessories.find(acc => acc.UUID === uuid);

        if (existing) {
            new HeatingMatDevice(this.log, deviceConfig, this.api, existing);
        } else {
            const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
            new HeatingMatDevice(this.log, deviceConfig, this.api, accessory);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
    }
}

module.exports = (api) => {
    api.registerPlatform(PLATFORM_NAME, HeatingMatPlatform);
};