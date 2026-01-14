const BleManager = require('./ble');
const { sleep, createControlPacket, parsePacket } = require('./utils');
const {
    WRITE_DELAY_MS,
    KEEP_ALIVE_INTERVAL_MS,
    KEEP_ALIVE_INITIAL_DELAY_MS,
    TEMP_LEVEL_MAP,
    LEVEL_TEMP_MAP,
    MIN_TEMP,
    MAX_TEMP,
    DEFAULT_HEAT_TEMP,
    MAX_TIMER_HOURS,
    BRIGHTNESS_PER_HOUR
} = require('./constants');


class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        this.bleManager = new BleManager(log, config);

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        this.device = null;
        this.adapter = null;
        this.isConnected = false;

        this.keepAliveTimer = null;
        this.keepAliveInterval = null;

        this.setTempTimeout = null;
        this.lastSentLevel = -1;

        this.serviceDisUuid = config.service_dis_uuid?.toLowerCase();
        this.charFirmwareUuid = config.char_firmware_uuid?.toLowerCase();

        this.currentState = {
            targetTemp: 0,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initBle();
    }

    async initBle() {
        try {
            this.adapter = await this.bleManager.initialize();
            this.bleManager.startScanningLoop(this.adapter, async (device) => {
                this.device = device;
                await this.connectDevice();
            });
        } catch (error) {
            this.log.error(`[BLE] 초기화 실패: ${error.message}`);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected) return;

        try {
            this.log.info(`[BLE] 연결 시도...`);
            await this.device.connect();

            await sleep(2000);

            this.isConnected = true;
            this.bleManager.isDeviceConnected = true;

            this.device.removeAllListeners('disconnect');
            this.device.on('disconnect', () => {
                this.log.warn('[BLE] 연결 해제됨. 재연결 시퀀스 준비.');
                this.disconnectDevice(true);
            });

            await this.discoverCharacteristics();
        } catch (error) {
            this.log.error(`[BLE] 연결 실패: ${error.message}`);
            this.disconnectDevice(true);
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            const service = await gatt.getPrimaryService(this.bleManager.serviceUuid);

            this.tempCharacteristic = await service.getCharacteristic(this.bleManager.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.bleManager.charTimeUuid);

            if (this.tempCharacteristic && this.timeCharacteristic) {
                if (this.bleManager.charSetUuid) {
                    this.setCharacteristic = await service.getCharacteristic(this.bleManager.charSetUuid);
                    await this.sendInitializationPacket();
                    await sleep(500);
                }

                this.log.debug('[BLE] Notification 설정 시작...');
                await this.tempCharacteristic.startNotifications();
                this.tempCharacteristic.on('valuechanged', (data) => this.handleNotification(data, 'temp'));
                await sleep(500);

                await this.timeCharacteristic.startNotifications();
                this.timeCharacteristic.on('valuechanged', (data) => this.handleNotification(data, 'timer'));
                await sleep(500);

                this.startKeepAlive();
                await sleep(500);

                this.log.info('[BLE] 모든 준비 완료. 상태 동기화 시도.');
                await this.syncDeviceState();
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 실패: ${error.message}`);
            this.disconnectDevice(true);
        }
    }

    async syncDeviceState() {
        try {
            if (!this.isConnected) return;

            const tempBuffer = await this.tempCharacteristic.readValue();
            const tempLevel = parsePacket(tempBuffer);
            const tempValue = LEVEL_TEMP_MAP[tempLevel] || 0;

            const timeBuffer = await this.timeCharacteristic.readValue();
            const timerHours = parsePacket(timeBuffer);

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

    handleNotification(data, type) {;
        const value = parsePacket(data);
        if (value === 0 || value === 255) return; // 0, 255 패킷 차단

        if (type === 'temp') {
            const targetTemp = LEVEL_TEMP_MAP[value];
            if (targetTemp) {
                this.currentState.targetTemp = targetTemp;
                this.currentState.currentTemp = targetTemp;
                this.currentState.currentHeatingCoolingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
                this.currentState.lastHeatTemp = targetTemp;

                this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, targetTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, targetTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);

                this.log.info(`[Sync] 온도 동기화: ${targetTemp}°C (레벨 ${value})`);
            }
        } else if (type === 'timer') {
            if (value <= MAX_TIMER_HOURS) {
                this.currentState.timerHours = value;
                const brightness = value * BRIGHTNESS_PER_HOUR;

                this.timerService.updateCharacteristic(this.Characteristic.On, value > 0);
                this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightness);

                this.log.info(`[Sync] 타이머 동기화: ${value}시간 (${Math.round(brightness)}%)`);
            }
        }
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

    async sendInitializationPacket(isKeepAlive = false) {
        if (!this.setCharacteristic || !this.isConnected || !this.bleManager.initPacketHex) {
            if (!isKeepAlive) this.log.warn('[Init] 조건 불충족.');
            return;
        }

        try {
            const initPacket = Buffer.from(this.bleManager.initPacketHex, 'hex');
            if (!isKeepAlive) {
                this.log.info(`[Init] 패킷: ${this.bleManager.initPacketHex}`);
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

    startKeepAlive() {
        this.stopKeepAlive();
        this.log.debug(`[KeepAlive] ${KEEP_ALIVE_INITIAL_DELAY_MS / 1000}초 후 ${KEEP_ALIVE_INTERVAL_MS / 1000}초 간격 시작.`);

        this.keepAliveTimer = setTimeout(() => {
            if (!this.isConnected) return;

            this.sendInitializationPacket(true).catch(() => {});

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

    disconnectDevice(resetDevice = false) {
        this.stopKeepAlive();

        const deviceToDisconnect = this.device;

        this.isConnected = false;
        this.bleManager.isDeviceConnected = false;

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
            try {
                await this.sendTemperatureCommand(36, 0);

                setTimeout(async () => {
                    try {
                        await this.sendTimerCommand(1);

                        this.timerService.updateCharacteristic(this.Characteristic.On, false);
                        this.timerService.updateCharacteristic(this.Characteristic.Brightness, 0);
                        this.currentState.timerOn = false;
                        this.currentState.timerHours = 0;
                    } catch (e) {
                        this.log.error(`[OFF Error] 타이머 종료 실패: ${e.message}`);
                    }
                }, 200);

                this.currentState.targetHeatingCoolingState = value;
                this.currentState.currentHeatingCoolingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
            } catch (e) {
                this.log.error(`[OFF Error] 종료 패킷 전송 실패: ${e.message}`);
            }
        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            const recoverTemp = this.currentState.lastHeatTemp || 37;
            this.log.info(`[HomeKit] ON 명령 수신. 마지막 온도 ${recoverTemp}°C로 복구.`);

            this.currentState.targetHeatingCoolingState = value;
            this.currentState.currentHeatingCoolingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;

            this.handleSetTargetTemperature(recoverTemp);
        }
    }

    handleSetTargetTemperature(value) {
        let level = 0;
        let newTargetTemp = 0;

        if (value <= 35) {
            level = 0;
            newTargetTemp = 36;
        } else {
            if (value > 42) value = 42;
            level = value - 35;
            newTargetTemp = value;
        }

        this.currentState.targetTemp = newTargetTemp;
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, newTargetTemp);
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, newTargetTemp);

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

        const packet = createControlPacket(level);
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
        let packet;
        if (hours === 0) {   // 종료 패킷
            packet = Buffer.from([0x00, 0xff, 0x00, 0xff]);
            this.log.info(`[Timer] OFF 명령 전송. 패킷: ${packet.toString('hex')}`);
        } else {
            packet = createControlPacket(hours);
            this.log.info(`[Timer] ${hours}시간 전송. 패킷: ${packet.toString('hex')}`);
        }

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

    getServices() {
        return [
            this.accessoryInformation,
            this.thermostatService,
            this.timerService
        ];
    }
}

module.exports = HeatingMatAccessory;