const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    WRITE_DELAY_MS: 300,
    RETRY_COUNT: 3,
    RECONNECT_DELAY: 15000,
    CONNECT_TIMEOUT: 20000,
    GATT_WAIT_MS: 1000,
    HEALTH_CHECK_INTERVAL: 30000,
    TEMP_LEVEL_MAP: { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 },
    LEVEL_TEMP_MAP: { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 },
    MIN_TEMP: 36,
    MAX_TEMP: 42,
    DEFAULT_HEAT_TEMP: 38,
    MAX_TIMER_HOURS: 12,
    BRIGHTNESS_PER_HOUR: 100 / 12,
};

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.name = config.name || '스마트 히팅 매트';
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase();
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase();
        this.initPacketHex = config.init_packet_hex;

        this.device = null;
        this.adapter = null;
        this.isConnected = false;
        this.healthCheckInterval = null;
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
        this.initNodeBle();
        this.startHealthCheck();
    }

    // --- 데이터 패킷 처리 ---
    createControlPacket(value) {
        const dataByte = value & 0xFF;
        const checkSum = (0xFF - dataByte) & 0xFF;
        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(dataByte, 0);
        buffer.writeUInt8(checkSum, 1);
        buffer.writeUInt8(dataByte, 2);
        buffer.writeUInt8(checkSum, 3);
        return buffer;
    }

    parsePacket(buffer, type) {
        if (!buffer || buffer.length < 4) return null;

        this.log.debug(`[Data Debug] Type: ${type}, Hex: ${buffer.toString('hex').toUpperCase()}`);

        const b0 = buffer.readUInt8(0);
        const b2 = buffer.readUInt8(2);
        const b3 = buffer.readUInt8(3);

        if (((b2 + b3) & 0xFF) === 0xFF) {
            const actualValue = (0xFF - b2) & 0xFF;
            if (type === 'temp' && b0 === 0xFC) return actualValue;
            if (type === 'timer' && b0 === 0xF7) return actualValue;
        } else {
            this.log.warn(`[Data Debug] 체크섬 불일치: b2(${b2}) + b3(${b3}) = ${(b2+b3)}`);
        }
        return null;
    }

    // --- HomeKit 서비스 설정 ---
    initServices() {
        this.informationService = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name);
        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: CONFIG.MIN_TEMP, maxValue: CONFIG.MAX_TEMP, minStep: 1 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(() => this.currentState.currentTemp);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머');
        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: CONFIG.BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    // --- BLE 핵심 로직 ---
    async initNodeBle() {
        try {
            const { bluetooth } = NodeBle.createBluetooth();
            this.adapter = await bluetooth.defaultAdapter();
            this.startScanningLoop();
        } catch (e) {
            this.log.error(`[BLE] 초기화 실패: ${e.message}`);
        }
    }

    async startScanningLoop() {
        while (true) {
            if (!this.isConnected) {
                try {
                    this.cleanup();
                    await this.adapter.startDiscovery();
                    await sleep(4000);
                    await this.adapter.stopDiscovery();
                    await sleep(2000);

                    const devices = await this.adapter.devices();
                    for (const addr of devices) {
                        if (addr.toUpperCase().replace(/:/g, '') === this.macAddress.toUpperCase()) {
                            this.device = await this.adapter.getDevice(addr);
                            await sleep(1500);
                            await this.connectDevice();
                            break;
                        }
                    }
                } catch (e) {
                    this.log.debug(`[BLE] 스캔 루프 오류: ${e.message}`);
                    try { await this.adapter.stopDiscovery(); } catch (i) {}
                }
            }
            await sleep(this.isConnected ? 10000 : 15000);
        }
    }

    async connectDevice() {
        if (this.isConnected) return;
        try {
            if (this.device) this.device.removeAllListeners('disconnect');

            this.log.info(`[BLE] 매트 연결 시도...`);
            await Promise.race([
                this.device.connect(),
                sleep(CONFIG.CONNECT_TIMEOUT).then(() => { throw new Error('연결 타임아웃'); })
            ]);

            await sleep(1000);
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            this.device.once('disconnect', () => {
                this.log.warn(`[BLE] 연결 끊김 감지. 곧 재연결 시도.`);
                this.isConnected = false;
                this.cleanup();
            });

            await this.discoverCharacteristics();
        } catch (e) {
            this.log.error(`[BLE] 연결 실패: ${e.message}`);
            this.isConnected = false;
            this.cleanup();
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            await sleep(CONFIG.GATT_WAIT_MS);

            const service = await gatt.getPrimaryService(this.serviceUuid);

            // 초기화 패킷 전송 (연결 유지 골든타임 확보)
            if (this.charSetUuid && this.initPacketHex) {
                this.setChar = await service.getCharacteristic(this.charSetUuid);
                await this.writeRaw(this.setChar, Buffer.from(this.initPacketHex, 'hex'));
                this.log.info(`[BLE] 초기화 패킷 전송 완료`);
                await sleep(500);
            }

            this.tempChar = await service.getCharacteristic(this.charTempUuid);
            this.timeChar = await service.getCharacteristic(this.charTimeUuid);

            await this.tempChar.startNotifications();
            this.tempChar.on('valuechanged', (data) => this.handleUpdate(data, 'temp'));
            await sleep(500);

            await this.timeChar.startNotifications();
            this.timeChar.on('valuechanged', (data) => this.handleUpdate(data, 'timer'));

            this.log.info(`[BLE] 서비스 및 알림 활성화 완료.`);
        } catch (e) {
            this.log.error(`[BLE] 탐색 오류: ${e.message}`);
            this.isConnected = false;
            if (this.device) this.device.disconnect().catch(() => {});
        }
    }

    cleanup() {
        this.device = null;
        this.tempChar = null;
        this.timeChar = null;
        this.setChar = null;
    }

    async writeRaw(characteristic, packet) {
        if (!this.isConnected || !characteristic) return false;
        for (let i = 0; i < CONFIG.RETRY_COUNT; i++) {
            try {
                await characteristic.writeValue(packet, { type: 'command' });
                return true;
            } catch (e) {
                await sleep(1000);
            }
        }
        return false;
    }

    startHealthCheck() {
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = setInterval(async () => {
            if (this.isConnected && this.tempChar) {
                try {
                    await this.tempChar.readValue();
                } catch (e) {
                    this.log.error(`[Health] 응답 없음. 재연결 시도.`);
                    this.isConnected = false;
                    if (this.device) this.device.disconnect().catch(() => {});
                }
            }
        }, CONFIG.HEALTH_CHECK_INTERVAL);
    }

    handleUpdate(data, type) {
        const val = this.parsePacket(data, type);
        if (val === null) return;

        if (type === 'temp') {
            const t = CONFIG.LEVEL_TEMP_MAP[val];
            if (t !== undefined && this.currentState.targetTemp !== t) {
                this.log.info(`[BLE] 수동 조작 - 온도: ${t}°C`);
                this.currentState.targetTemp = t;
                this.currentState.currentTemp = t;
                this.currentState.currentHeatingCoolingState = (val > 0) ? 1 : 0;
                if (val > 0) this.currentState.lastHeatTemp = t;
                this.updateHomeKit();
            }
        } else if (type === 'timer') {
            if (this.currentState.timerHours !== val) {
                this.log.info(`[BLE] 수동 조작 - 타이머: ${val}시간`);
                this.currentState.timerHours = val;
                this.currentState.timerOn = (val > 0);
                this.updateHomeKit();
            }
        }
    }

    updateHomeKit() {
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState);
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTargetHeatingCoolingState(value) {
        const level = value === 0 ? 0 : (CONFIG.TEMP_LEVEL_MAP[this.currentState.lastHeatTemp] || 3);
        const success = await this.writeRaw(this.tempChar, this.createControlPacket(level));
        if (success) {
            this.currentState.currentHeatingCoolingState = value;
            this.log.info(`[HomeKit] 전원 ${value === 0 ? 'OFF' : 'ON'}`);
            this.updateHomeKit();
        }
    }

    async handleSetTargetTemperature(v) {
        this.currentState.targetTemp = v;
        if (this.setTempTimeout) clearTimeout(this.setTempTimeout);
        this.setTempTimeout = setTimeout(async () => {
            const level = CONFIG.TEMP_LEVEL_MAP[v] || 0;
            const success = await this.writeRaw(this.tempChar, this.createControlPacket(level));
            if (success && level > 0) this.currentState.lastHeatTemp = v;
        }, 500);
    }

    async handleTimerSwitch(v) {
        const h = v ? Math.max(1, this.currentState.timerHours) : 0;
        await this.handleSetTimerHours(h * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTimerHours(v) {
        const h = Math.round(v / CONFIG.BRIGHTNESS_PER_HOUR);
        const packet = h === 0 ? Buffer.from([0x00, 0xff, 0x00, 0xff]) : this.createControlPacket(h);
        const success = await this.writeRaw(this.timeChar, packet);
        if (success) {
            this.currentState.timerHours = h;
            this.currentState.timerOn = h > 0;
            this.updateHomeKit();
        }
    }

    getServices() {
        return [this.informationService, this.thermostatService, this.timerService];
    }
}

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'Heating Mat', HeatingMatAccessory);
};