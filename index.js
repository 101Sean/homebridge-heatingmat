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

    parsePacket(buffer) {
        if (!buffer || buffer.length < 4) return 255;
        return buffer.readUInt8(3); // 체크섬 위치나 마지막 데이터 위치에 따라 조정 필요
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
                    await this.adapter.startDiscovery();
                    await sleep(3000);
                    await this.adapter.stopDiscovery();

                    const devices = await this.adapter.devices();
                    for (const addr of devices) {
                        if (addr.toUpperCase().replace(/:/g, '') === this.macAddress.toUpperCase()) {
                            this.device = await this.adapter.getDevice(addr);
                            await this.connectDevice();
                            break;
                        }
                    }
                } catch (e) {
                    this.log.debug(`[BLE] 스캔 루프 오류: ${e.message}`);
                }
            }
            await sleep(10000);
        }
    }

    async connectDevice() {
        if (this.isConnected) return;
        try {
            this.log.info(`[BLE] 매트 연결 시도...`);

            const connectPromise = this.device.connect();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('연결 타임아웃')), CONFIG.CONNECT_TIMEOUT)
            );

            await Promise.race([connectPromise, timeoutPromise]);
            await sleep(1000);

            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 연결 끊김 감지.`);
                this.isConnected = false;
            });

            await this.discoverCharacteristics();
        } catch (e) {
            this.log.error(`[BLE] 연결 실패: ${e.message}`);
            this.isConnected = false;
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            const service = await gatt.getPrimaryService(this.serviceUuid);

            this.tempChar = await service.getCharacteristic(this.charTempUuid);
            this.timeChar = await service.getCharacteristic(this.charTimeUuid);

            if (this.charSetUuid && this.initPacketHex) {
                this.setChar = await service.getCharacteristic(this.charSetUuid);
                await this.writeRaw(this.setChar, Buffer.from(this.initPacketHex, 'hex'));
            }

            // Notification 활성화 (기기 상태 실시간 동기화)
            await this.tempChar.startNotifications();
            this.tempChar.on('valuechanged', (data) => this.handleUpdate(data, 'temp'));

            await this.timeChar.startNotifications();
            this.timeChar.on('valuechanged', (data) => this.handleUpdate(data, 'timer'));

            this.log.info(`[BLE] 서비스 및 알림 활성화 완료.`);
        } catch (e) {
            this.log.error(`[BLE] 탐색 중 오류: ${e.message}`);
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
            }
        }
        return false;
    }

    startHealthCheck() {
        this.healthCheckInterval = setInterval(async () => {
            if (this.isConnected && this.tempChar) {
                try {
                    await this.tempChar.readValue();
                } catch (e) {
                    this.log.error(`[Health] 연결 응답 없음. 재연결 필요.`);
                    this.isConnected = false;
                }
            }
        }, CONFIG.HEALTH_CHECK_INTERVAL);
    }

    handleUpdate(data, type) {
        const val = this.parsePacket(data);
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
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
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