const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    WRITE_DELAY_MS: 300,
    RETRY_COUNT: 3,
    RECONNECT_DELAY: 10000,
    CONNECT_TIMEOUT: 20000,
    GATT_WAIT_MS: 500,
    PING_INTERVAL: 15000,
    TEMP_LEVEL_MAP: { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 },
    LEVEL_TEMP_MAP: { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 },
    MIN_TEMP: 36,
    MAX_TEMP: 42,
    DEFAULT_HEAT_TEMP: 38,
    MAX_TIMER_HOURS: 15,
    BRIGHTNESS_PER_HOUR: 100 / 15
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

    parsePacket(buffer, type) {
        if (!buffer || buffer.length < 4) return null;
        const b2 = buffer.readUInt8(2);
        const b3 = buffer.readUInt8(3);

        if (((b2 + b3) & 0xFF) === 0xFF) {
            return (0xFF - b2) & 0xFF;
        }
        return null;
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
                    this.log.debug(`[BLE] 주변 기기 검색 중...`);
                    await this.adapter.startDiscovery();
                    await sleep(3000);
                    await this.adapter.stopDiscovery();

                    const devices = await this.adapter.devices();
                    for (const addr of devices) {
                        if (addr.toUpperCase().replace(/:/g, '') === this.macAddress.toUpperCase()) {
                            this.device = await this.adapter.getDevice(addr);
                            try { await this.device.disconnect(); } catch(e) {}
                            await this.connectDevice();
                            break;
                        }
                    }
                } catch (e) {
                    this.log.error(`[BLE] 스캔 중 오류: ${e.message}`);
                    try { await this.adapter.stopDiscovery(); } catch(e) {}
                }
            }
            await sleep(CONFIG.RECONNECT_DELAY);
        }
    }

    async connectDevice() {
        try {
            this.log.info(`[BLE] 매트 접속 시도...`);

            const connectPromise = this.device.connect();
            const timeoutPromise = sleep(5000).then(() => { throw new Error('Connect Timeout'); });

            await Promise.race([connectPromise, timeoutPromise]);

            this.isConnected = true;
            this.log.info(`[BLE] 연결 성공.`);

            this.device.once('disconnect', () => {
                this.log.warn(`[BLE] 연결 유실. 재시도를 준비합니다.`);
                this.isConnected = false;
                this.stopPingLoop();
                this.device.disconnect().catch(() => {});
            });

            await this.discoverCharacteristics();
        } catch (e) {
            this.log.error(`[BLE] 연결 실패: ${e.message}`);
            this.isConnected = false;
            if (this.device) {
                await this.device.disconnect().catch(() => {});
            }
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            await sleep(CONFIG.GATT_WAIT_MS);
            const service = await gatt.getPrimaryService(this.serviceUuid);

            this.setChar = await service.getCharacteristic(this.charSetUuid)
            this.tempChar = await service.getCharacteristic(this.charTempUuid);
            this.timeChar = await service.getCharacteristic(this.charTimeUuid);

            this.log.info(`[BLE] 1단계: 인증 패킷 전송`);
            await this.writeRaw(this.setChar, Buffer.from(this.initPacketHex, 'hex'));

            this.log.info(`[BLE] 2단계: 알림 리스너 등록`);
            await this.tempChar.startNotifications();
            this.tempChar.on('valuechanged', (data) => this.handleUpdate(data, 'temp'));
            await this.timeChar.startNotifications();
            this.timeChar.on('valuechanged', (data) => this.handleUpdate(data, 'timer'));
            await sleep(300);

            this.log.info(`[BLE] 3단계: 상태 요청(0x12) 전송`);
            await this.writeRaw(this.tempChar, this.createControlPacket(0x12));

            this.startPingLoop();
            this.log.info(`[BLE] 최종 연결 유지 프로세스 시작`);
        } catch (e) {
            this.log.error(`[BLE] 탐색 오류: ${e.message}`);
            this.isConnected = false;
            if (this.device) await this.device.disconnect().catch(() => {});
        }
    }

    async setupDescriptor(characteristic) {
        try {
            // 표준 CCCD UUID는 00002902-0000-1000-8000-00805f9b34fb 입니다.
            const descriptor = await characteristic.getDescriptor('00002902-0000-1000-8000-00805f9b34fb');
            // '01 00'은 알림(Notification) 활성화를 의미합니다.
            await descriptor.writeValue(Buffer.from([0x01, 0x00]));
        } catch (e) {
            this.log.warn(`[BLE] Descriptor 설정 건너뜀 (이미 활성화되었거나 미지원): ${e.message}`);
        }
    }

    startPingLoop() {
        this.stopPingLoop();
        this.pingInterval = setInterval(async () => {
            if (!this.isConnected || !this.tempChar) return;
            try {
                await this.writeRaw(this.tempChar, this.createControlPacket(0x12));
                this.log.debug(`[BLE] Ping (0x12) 발송`);
            } catch (e) {
                this.log.warn(`[BLE] Ping 실패: ${e.message}`);
            }
        }, CONFIG.PING_INTERVAL);
    }

    stopPingLoop() {
        if (this.pingInterval) clearInterval(this.pingInterval);
    }

    async writeRaw(characteristic, packet) {
        if (!this.isConnected || !characteristic) return false;

        for (let i = 0; i < CONFIG.RETRY_COUNT; i++) {
            try {
                await characteristic.writeValue(packet, { type: 'command' });
                return true;
            } catch (e) {
                this.log.warn(`[BLE] 쓰기 실패 (${i+1}/3), ${CONFIG.WRITE_DELAY_MS}ms 후 재시도...`);
                await sleep(CONFIG.WRITE_DELAY_MS);
            }
        }
        return false;
    }

    handleUpdate(data, type) {
        const val = this.parsePacket(data, type);
        if (val === null) return;

        if (type === 'temp') {
            const tempValue = CONFIG.LEVEL_TEMP_MAP[val];
            if (tempValue !== undefined) {
                if (this.currentState.currentTemp !== tempValue || this.currentState.currentHeatingCoolingState !== (val > 0 ? 1 : 0)) {
                    this.log.debug(`[수동] 온도: ${tempValue}°C (Level: ${val})`);

                    this.currentState.currentTemp = tempValue;
                    this.currentState.targetTemp = tempValue;
                    this.currentState.currentHeatingCoolingState = (val > 0) ? 1 : 0;
                    if (val > 0) this.currentState.lastHeatTemp = tempValue;

                    this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, tempValue);
                    this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, tempValue);
                    this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                    this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                }
            }
        } else if (type === 'timer') {
            if (this.currentState.timerHours !== val) {
                this.log.debug(`[수동] 타이머: ${val}시간`);

                this.currentState.timerHours = val;
                this.currentState.timerOn = (val > 0);

                this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
                this.timerService.updateCharacteristic(this.Characteristic.Brightness, val * CONFIG.BRIGHTNESS_PER_HOUR);
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
            .onSet(async (v) => {
                const h = v ? Math.max(1, this.currentState.timerHours) : 0;
                await this.handleSetTimerHours(h * CONFIG.BRIGHTNESS_PER_HOUR);
            })
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: CONFIG.BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * CONFIG.BRIGHTNESS_PER_HOUR);
    }

    async handleSetTargetHeatingCoolingState(value) {
        const level = value === 0 ? 0 : (CONFIG.TEMP_LEVEL_MAP[this.currentState.lastHeatTemp] || 3);
        const success = await this.writeRaw(this.tempChar, this.createControlPacket(level));
        if (success) {
            this.currentState.currentHeatingCoolingState = value;
            if (value === 0) {
                this.log.info(`[제어] 전원 OFF (타이머 1시간)`);
                this.currentState.timerHours = 1;
                this.currentState.timerOn = false;
            }
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