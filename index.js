const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    WRITE_DELAY_MS: 300,
    RETRY_COUNT: 3,
    RECONNECT_DELAY: 5000,
    CONNECT_TIMEOUT: 30000,
    GATT_WAIT_MS: 1500,
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
        this.reconnectAttempts = 0;
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

    parsePacket(buffer, characteristicType) {
        if (!buffer || buffer.length < 4) return null;

        const b0 = buffer.readUInt8(0);
        const b1 = buffer.readUInt8(1);
        const b2 = buffer.readUInt8(2); // data
        const b3 = buffer.readUInt8(3); // checksum

        const isHeaderValid = ((b0 + b1) & 0xFF) === 0xFF;
        const isDataValid = ((b2 + b3) & 0xFF) === 0xFF;

        if (isHeaderValid && isDataValid) {
            const actualValue = (0xFF - b2) & 0xFF;
            if (characteristicType === 'temp' && b0 === 0xFC) return actualValue;
            if (characteristicType === 'timer' && b0 === 0xF7) return actualValue;
        }
        return null;
    }

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
            .setProps({ validValues: [0, 1] }) // OFF, HEAT
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
                    this.log.debug(`[BLE] 기기 검색 중...`);
                    this.device = null;

                    await this.adapter.startDiscovery();
                    await sleep(3000);
                    await this.adapter.stopDiscovery();

                    const devices = await this.adapter.devices();
                    let found = false;

                    for (const addr of devices) {
                        if (addr.toUpperCase().replace(/:/g, '') === this.macAddress.toUpperCase()) {
                            this.log.info(`[BLE] 매트 발견 (${addr}), 연결을 시도합니다.`);
                            this.device = await this.adapter.getDevice(addr);
                            found = true;
                            break;
                        }
                    }

                    if (found) {
                        await sleep(1000);
                        await this.connectDevice();
                    } else {
                        this.log.debug(`[BLE] 주변에 매트가 없습니다. 10초 후 다시 스캔합니다.`);
                    }
                } catch (e) {
                    this.log.error(`[BLE] 스캔 루프 에러: ${e.message}`);
                    try { await this.adapter.stopDiscovery(); } catch (i) {}
                }
            }
            await sleep(this.isConnected ? 5000 : 10000);
        }
    }

    async connectDevice() {
        if (this.isConnected) return;
        try {
            if (this.device) {
                this.device.removeAllListeners('disconnect');
            }

            const connectPromise = this.device.connect();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('연결 타임아웃')), CONFIG.CONNECT_TIMEOUT)
            );

            await Promise.race([connectPromise, timeoutPromise]);
            await sleep(1000);

            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 연결 끊김 감지! 재연결을 시도합니다.`);
                this.isConnected = false;
                this.device = null;
            });

            await this.discoverCharacteristics();
        } catch (e) {
            this.log.error(`[BLE] 연결 실패: ${e.message}`);
            this.isConnected = false;
            this.device = null;
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            await sleep(CONFIG.GATT_WAIT_MS);

            const service = await gatt.getPrimaryService(this.serviceUuid);
            this.tempChar = await service.getCharacteristic(this.charTempUuid);
            this.timeChar = await service.getCharacteristic(this.charTimeUuid);

            if (this.charSetUuid && this.initPacketHex) {
                this.setChar = await service.getCharacteristic(this.charSetUuid);
                const success = await this.writeRaw(this.setChar, Buffer.from(this.initPacketHex, 'hex'));
                if (success) this.log.info(`[BLE] 초기화 패킷 전송 완료`);
                await sleep(1000);
            }

            await this.tempChar.startNotifications();
            this.tempChar.on('valuechanged', (data) => this.handleUpdate(data, 'temp'));
            await sleep(500);

            await this.timeChar.startNotifications();
            this.timeChar.on('valuechanged', (data) => this.handleUpdate(data, 'timer'));

            this.log.info(`[BLE] 서비스 및 알림 활성화 완료.`);
        } catch (e) {
            this.log.error(`[BLE] 탐색 중 오류: ${e.message}`);
            this.isConnected = false;
        }
    }

    async writeRaw(characteristic, packet) {
        if (!this.isConnected || !characteristic) return false;
        for (let i = 0; i < CONFIG.RETRY_COUNT; i++) {
            try {
                await characteristic.writeValue(packet, { type: 'command' });
                await sleep(CONFIG.WRITE_DELAY_MS);
                return true;
            } catch (e) {
                this.log.warn(`[BLE] 쓰기 시도 ${i+1} 실패: ${e.message}`);
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
                    this.log.debug(`[Health] 연결 상태 양호`);
                } catch (e) {
                    this.log.error(`[Health] 연결 응답 없음 (${e.message}). 재연결 프로세스 시작.`);
                    this.isConnected = false;

                    try {
                        if (this.device) {
                            await this.device.disconnect();
                        }
                    } catch (disconnectError) {
                        this.log.debug(`[Health] 강제 연결 해제 중 오류(이미 끊겼을 수 있음): ${disconnectError.message}`);
                    }

                    this.device = null;
                    this.tempChar = null;
                    this.timeChar = null;
                    this.setChar = null;
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
                this.log.info(`[BLE] 수동 조작 감지 - 온도: ${t}°C (레벨 ${val})`);
                this.currentState.targetTemp = t;
                this.currentState.currentTemp = t;
                this.currentState.currentHeatingCoolingState = (val > 0) ? 1 : 0;
                if (val > 0) this.currentState.lastHeatTemp = t;
                this.updateHomeKit();
            }
        } else if (type === 'timer') {
            if (this.currentState.timerHours !== val) {
                this.log.info(`[BLE] 수동 조작 감지 - 타이머: ${val}시간`);
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
            this.log.info(`[HomeKit] 전원 ${value === 0 ? 'OFF' : 'ON'} 완료`);
        }
    }

    async handleSetTargetTemperature(v) {
        this.currentState.targetTemp = v;
        if (this.setTempTimeout) clearTimeout(this.setTempTimeout);

        this.setTempTimeout = setTimeout(async () => {
            const level = CONFIG.TEMP_LEVEL_MAP[v] || 0;
            const success = await this.writeRaw(this.tempChar, this.createControlPacket(level));
            if (success) {
                if (level > 0) this.currentState.lastHeatTemp = v;
                this.log.info(`[HomeKit] 온도 변경: ${v}°C (레벨 ${level})`);
            }
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
            this.log.info(`[HomeKit] 타이머 설정: ${h}시간`);
        }
    }

    getServices() {
        return [this.informationService, this.thermostatService, this.timerService];
    }
}

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'Heating Mat', HeatingMatAccessory);
};