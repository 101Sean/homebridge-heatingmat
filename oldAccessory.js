const NodeBle = require('node-ble');
const util = require('util');

const WRITE_DELAY_MS = 300;
const KEEP_ALIVE_INTERVAL_MS = 10000;
const KEEP_ALIVE_INITIAL_DELAY_MS = 3000;

const TEMP_LEVEL_MAP = { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 };
const LEVEL_TEMP_MAP = { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 };
const MIN_TEMP = 36;
const MAX_TEMP = 42;
const DEFAULT_HEAT_TEMP = 38;

const MAX_TIMER_HOURS = 12;
const BRIGHTNESS_PER_HOUR = 100 / MAX_TIMER_HOURS;

const sleep = util.promisify(setTimeout);

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase();
        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = 5000;
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase();
        this.initPacketHex = config.init_packet_hex;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json 필수 설정 누락');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        this.device = null;
        this.adapter = null;
        this.isConnected = false;

        this.isScanningLoopActive = false;

        this.keepAliveTimer = null;
        this.keepAliveInterval = null;

        this.setTempTimeout = null;
        this.lastSentLevel = -1;

        this.currentState = {
            targetTemp: 0,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle();
    }

    async sendInitialKeepAlivePacket() {
        try {
            await this.sendInitializationPacket(true);
            this.log.debug('[KeepAlive] 첫 번째 초기 Keep-Alive 패킷 전송 완료.');
        } catch (e) {
            this.log.debug('[KeepAlive] 첫 번째 Keep-Alive 패킷 전송 실패.');
        }
    }

    startKeepAlive() {
        this.stopKeepAlive();
        this.log.debug(`[KeepAlive] ${KEEP_ALIVE_INITIAL_DELAY_MS / 1000}초 후 ${KEEP_ALIVE_INTERVAL_MS / 1000}초 간격 시작.`);

        this.keepAliveTimer = setTimeout(() => {
            if (!this.isConnected) return;

            this.sendInitialKeepAlivePacket();

            this.keepAliveInterval = setInterval(async () => {
                if (this.isConnected) {
                    try {
                        await this.sendInitializationPacket(true);
                    } catch (e) {
                        this.log.debug('[KeepAlive] 실패.');
                    }
                }
            }, KEEP_ALIVE_INTERVAL_MS);
        }, KEEP_ALIVE_INITIAL_DELAY_MS);
    }

    stopKeepAlive() {
        if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        this.log.debug('[KeepAlive] 중지.');
    }

    async safeWriteValue(characteristic, packet, maxRetries = 3, delayMs = WRITE_DELAY_MS) {
        if (!this.isConnected) throw new Error("Device not connected.");

        const writeOptions = { type: 'command' };
        let retryCnt = 0;

        while (retryCnt < maxRetries) {
            try {
                await characteristic.writeValue(packet, writeOptions);
                this.log.debug(`[BLE Write] 성공 (시도 ${retryCnt + 1}/${maxRetries})`);
                await sleep(delayMs);
                return true;
            } catch (error) {
                retryCnt++;
                this.log.warn(`[BLE Write] 오류 (시도 ${retryCnt}/${maxRetries}): ${error.message}`);
                if (error.message.includes('0x0e')) {
                    this.log.error('[BLE Write] ATT 0x0e 오류. 연결 해제.');
                    this.disconnectDevice(true);
                    throw error;
                }
                if (retryCnt === maxRetries) {
                    this.log.error('[BLE Write] 최종 실패.');
                    this.disconnectDevice();
                    throw error;
                }
                await sleep(delayMs);
            }
        }
    }

    createControlPacket(value) {
        const dataByte = value;
        const checkSum = (0xFF - dataByte) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(dataByte, 0);
        buffer.writeUInt8(checkSum, 1);
        buffer.writeUInt8(dataByte, 2);
        buffer.writeUInt8(checkSum, 3);

        return buffer;
    }

    async sendInitializationPacket(isKeepAlive = false) {
        if (!this.setCharacteristic || !this.isConnected || !this.initPacketHex) {
            if (!isKeepAlive) this.log.warn('[Init] 조건 불충족.');
            return;
        }

        try {
            const initPacket = Buffer.from(this.initPacketHex, 'hex');
            if (!isKeepAlive) {
                this.log.info(`[Init] 초기화 패킷: ${this.initPacketHex}`);
            }

            await this.setCharacteristic.writeValue(initPacket, { type: 'command' });

            if (!isKeepAlive) {
                await sleep(500);
                this.log.info('[Init] 성공.');
            }
        } catch (error) {
            if (!isKeepAlive) {
                this.log.error(`[Init] 오류: ${error.message}`);
                this.disconnectDevice(true);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
            throw error;
        }
    }

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTemp);

        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.OFF, this.Characteristic.TargetHeatingCoolingState.HEAT]
        });
        targetHeatingCoolingStateCharacteristic
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF ? this.Characteristic.TargetHeatingCoolingState.OFF : this.Characteristic.TargetHeatingCoolingState.HEAT);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * BRIGHTNESS_PER_HOUR);

        this.timerService.setCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * BRIGHTNESS_PER_HOUR);
        this.timerService.setCharacteristic(this.Characteristic.On, this.currentState.timerOn);
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] OFF 명령. Level 0.');
            this.handleSetTargetTemperature(MIN_TEMP);
        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] ON 명령. 마지막 온도 ${this.currentState.lastHeatTemp}°C 복구.`);
            this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    handleSetTargetTemperature(value) {
        let level = 0;
        let newTargetTemp = 0;

        if (value <= 0) {
            level = 0;
            newTargetTemp = 0;
        } else {
            if (value < 36) value = 36;
            if (value > 42) value = 42;

            level = value - 35;
            newTargetTemp = value;
        }

        this.currentState.targetTemp = newTargetTemp;
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, newTargetTemp);

        this.log.debug(`[Temp] 요청 ${value}°C → ${newTargetTemp > 0 ? 'HEAT' : 'OFF'} (레벨 ${level})`);

        if (level === this.lastSentLevel) {
            this.log.info(`[Temp Debounce] 동일 레벨 ${level}.`);
            return;
        }

        if (this.setTempTimeout) clearTimeout(this.setTempTimeout);

        this.setTempTimeout = setTimeout(async () => {
            try {
                await this.sendTemperatureCommand(newTargetTemp, level);
            } catch (e) {
                this.log.error(`[Temp Error] ${e.message}`);
            }
        }, 350);
    }

    async sendTemperatureCommand(value, level) {
        this.setTempTimeout = null;

        const packet = this.createControlPacket(level);
        this.log.debug(`[Temp Command] Level ${level} 전송. 패킷: ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.tempCharacteristic, packet);
                this.lastSentLevel = level;

                this.currentState.targetTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState = level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) this.currentState.lastHeatTemp = LEVEL_TEMP_MAP[level];

                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF ? this.Characteristic.TargetHeatingCoolingState.OFF : this.Characteristic.TargetHeatingCoolingState.HEAT);
            } catch (error) {
                this.log.error(`[Temp Command] 오류: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            if (level === 0) {
                this.log.warn('[Temp Command] 연결 없음. OFF 명령 스킵.');
            } else {
                this.log.warn('[Temp Command] 연결 없음. 재연결 중.');
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
    }

    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) hours = 1;
        if (hours > MAX_TIMER_HOURS) hours = MAX_TIMER_HOURS;

        if (hours === 0) {
            this.log.info('[Timer] 0시간. OFF.');
            this.handleSetTargetTemperature(MIN_TEMP);
        }

        await this.sendTimerCommand(hours);

        this.currentState.timerHours = hours;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
        this.log.info(`[Timer] ${value}% → ${hours}시간.`);
    }

    async handleTimerSwitch(value) {
        let hoursToSend = 0;
        let brightnessToSet = 0;

        if (value === false) {
            hoursToSend = 0;
            brightnessToSet = 0;
            this.log.info('[Timer] OFF. 해제.');
            this.handleSetTargetTemperature(MIN_TEMP);
        } else {
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                brightnessToSet = BRIGHTNESS_PER_HOUR;
                this.log.info('[Timer] ON. 1시간 설정.');
            } else {
                brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
                this.log.info(`[Timer] ON. ${hoursToSend}시간.`);
            }
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHours = hoursToSend;
        this.currentState.timerOn = value;

        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hours) {
        const packet = this.createControlPacket(hours);
        this.log.info(`[Timer] ${hours}시간 전송. 패킷: ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.timeCharacteristic, packet);
            } catch (error) {
                this.log.error(`[Timer] 오류: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            if (hours === 0) {
                this.log.warn('[Timer] 연결 없음. OFF 스킵.');
            } else {
                this.log.warn('[Timer] 연결 없음. 재연결 중.');
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
    }

    async initNodeBle() {
        await this.initializeBleAdapter();
    }

    async initializeBleAdapter() {
        try {
            const { bluetooth } = NodeBle.createBluetooth();
            let adapter = await bluetooth.defaultAdapter();
            this.adapter = adapter;
            this.log.info('[BLE] 어댑터 초기화 성공.');
            await this.startScanningLoop();
        } catch (error) {
            this.log.error(`[BLE] 초기화 실패: ${error.message}`);
        }
    }

    async startScanningLoop() {
        if (!this.adapter || this.isScanningLoopActive) return;

        this.isScanningLoopActive = true;
        while (this.isScanningLoopActive) {
            if (!this.isConnected) {
                try {
                    await this.adapter.startDiscovery();
                    const targetAddress = this.macAddress.toUpperCase();
                    await sleep(5000);
                    await this.adapter.stopDiscovery();
                    await sleep(5000);

                    const deviceAddresses = await this.adapter.devices();
                    let targetDevice = null;

                    for (const address of deviceAddresses) {
                        const normalized = address.toUpperCase().replace(/:/g, '');
                        if (normalized === targetAddress) {
                            targetDevice = await this.adapter.getDevice(address);
                            break;
                        }
                    }

                    if (targetDevice) {
                        this.device = targetDevice;
                        this.log.info(`[BLE] 발견: ${targetAddress}`);
                        await this.connectDevice();
                    } else {
                        this.log.debug(`[BLE] 발견 실패: ${targetAddress}`);
                    }
                } catch (error) {
                    this.log.error(`[BLE] 스캔 오류: ${error.message}`);
                }
            }
            await sleep(this.scanInterval);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected) return;

        let retryCnt = 0;
        while (retryCnt < 3) {
            try {
                this.log.info(`[BLE] 연결 시도 (${retryCnt + 1}/3)...`);
                await this.device.connect();
                this.isConnected = true;
                this.log.info('[BLE] 연결 성공.');

                this.device.on('disconnect', () => {
                    this.log.warn('[BLE] 해제. 재연결.');
                    this.disconnectDevice(true);
                });

                await sleep(1000);
                await this.discoverCharacteristics();
                await this.syncDeviceState();

                break;
            } catch (error) {
                retryCnt++;
                this.log.error(`[BLE] 실패: ${error.message}. 재시도.`);
                await sleep(300);
                if (retryCnt === 3) this.disconnectDevice(true);
            }
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            const service = await gatt.getPrimaryService(this.serviceUuid);

            if (this.charSetUuid) {
                this.setCharacteristic = await service.getCharacteristic(this.charSetUuid);
            }
            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);

            if (this.tempCharacteristic && this.timeCharacteristic) {
                if (this.setCharacteristic) await this.sendInitializationPacket();
                this.startKeepAlive();

                await this.tempCharacteristic.startNotifications();
                this.tempCharacteristic.on('data', (data) => this.handleNotification(data, 'temp'));

                await this.timeCharacteristic.startNotifications();
                this.timeCharacteristic.on('data', (data) => this.handleNotification(data, 'timer'));
            } else {
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 오류: ${error.message}`);
            this.disconnectDevice(true);
        }
    }

    async syncDeviceState() {
        try {
            if (!this.isConnected) return;

            const tempBuffer = await this.tempCharacteristic.readValue();
            const tempLevel = this.parsePacket(tempBuffer);
            const tempValue = LEVEL_TEMP_MAP[tempLevel] || 0;

            const timeBuffer = await this.timeCharacteristic.readValue();
            const timerHours = this.parsePacket(timeBuffer);

            this.currentState.targetTemp = tempValue;
            this.currentState.currentTemp = tempValue;
            this.currentState.currentHeatingCoolingState = tempLevel > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;
            this.currentState.timerHours = timerHours;
            this.currentState.timerOn = timerHours > 0;
            if (tempLevel > 0) this.currentState.lastHeatTemp = tempValue;

            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, tempValue);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, tempValue);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, timerHours * BRIGHTNESS_PER_HOUR);
            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);

            this.log.info(`[Sync] 온도 ${tempValue}°C, 타이머 ${timerHours}시간`);
        } catch (e) {
            this.log.error(`[Sync] 실패: ${e.message}`);
        }
    }

    handleNotification(data, type) {
        const value = this.parsePacket(data);
        if (type === 'temp') {
            const tempValue = LEVEL_TEMP_MAP[value] || 0;
            this.currentState.targetTemp = tempValue;
            this.currentState.currentTemp = tempValue;
            this.currentState.currentHeatingCoolingState = value > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;
            if (value > 0) this.currentState.lastHeatTemp = tempValue;

            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, tempValue);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, tempValue);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
        } else if (type === 'timer') {
            this.currentState.timerHours = value;
            this.currentState.timerOn = value > 0;

            this.timerService.updateCharacteristic(this.Characteristic.Brightness, value * BRIGHTNESS_PER_HOUR);
            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        }
        this.log.debug(`[Notify] ${type}: ${value}`);
    }

    parsePacket(buffer) {
        if (buffer.length < 4) return 0;
        const dataByte = buffer.readUInt8(0);
        const checkSum = buffer.readUInt8(1);
        if (checkSum !== (0xFF - dataByte) & 0xFF) {
            this.log.warn('[Parse] 체크섬 오류');
            return 0;
        }
        return dataByte;
    }

    disconnectDevice(resetDevice = false) {
        this.stopKeepAlive();

        const deviceToDisconnect = this.device;

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        if (resetDevice) this.device = null;

        if (deviceToDisconnect) {
            deviceToDisconnect.disconnect().catch(e => {
                if (!e.message.includes('not connected') && !e.message.includes('does not exist')) {
                    this.log.warn(`[BLE] 해제 실패: ${e.message}`);
                }
            });
        }

        if (this.adapter) {
            this.adapter.stopDiscovery().catch(() => {});
        }
    }

    getServices() {
        return [
            this.accessoryInformation,
            this.thermostatService,
            this.timerService
        ];
    }
}

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'Heating Mat', HeatingMatAccessory);
};