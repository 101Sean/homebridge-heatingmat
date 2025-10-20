const noble = require('noble');
const util = require('util');

const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

const MAX_TIMER_HOURS = 10;
const BRIGHTNESS_PER_HOUR = 10;

const sleep = util.promisify(setTimeout);

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');

        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase().replace(/-/g, '');
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase().replace(/-/g, '');
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase().replace(/-/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase().replace(/-/g, '');

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_timer_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || 'Heating Mat';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        this.peripheral = null;
        this.isConnected = false;

        this.isScanningLoopActive = false;
        this.scanInterval = 10000; // 스캔 주기 (10초)

        this.currentState = {
            targetTemp: MIN_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNoble();
    }

    createControlPacket(value) {
        const dataByte = value;
        const checkSum = (0xFF - dataByte) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(dataByte, 0);
        buffer.writeUInt8(checkSum, 1);
        buffer.writeUInt8(0x00, 2);
        buffer.writeUInt8(0x00, 3);

        return buffer;
    }

    async sendInitializationPacket() {
        return;
    }

    // BLE 쓰기 함수 (재시도 로직 포함)
    async safeWriteValue(characteristic, packet, maxRetries = 2, delayMs = 300) {
        if (!this.isConnected || !characteristic) {
            throw new Error("Device not connected or characteristic invalid. Cannot write.");
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.write(packet, true);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}). 패킷: ${packet.toString('hex')}`);

                await sleep(delayMs);

                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}): ${error.message}`);

                if (attempt === maxRetries) {
                    this.log.error(`[BLE Write] 최종 쓰기 실패. 연결 해제 및 재시도 루프 시작.`);
                    this.disconnectDevice(true);
                    throw error;
                }

                await sleep(delayMs);
            }
        }
    }

    initServices() {
        // AccessoryInformation Service
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Heating Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        // Thermostat Service (온도 제어)
        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTemp);

        // TargetHeatingCoolingState (전원 ON/OFF)
        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.OFF, this.Characteristic.TargetHeatingCoolingState.HEAT]
        });
        targetHeatingCoolingStateCharacteristic
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => {
                return this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        // Lightbulb Service (타이머 제어 - 밝기를 시간으로 매핑)
        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * BRIGHTNESS_PER_HOUR);

        // 초기 HomeKit 상태 설정
        this.timerService.setCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * BRIGHTNESS_PER_HOUR);
        this.timerService.setCharacteristic(this.Characteristic.On, this.currentState.timerOn);
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 (15°C)로 설정합니다.');
            await this.handleSetTargetTemperature(MIN_TEMP);

        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            await this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    async handleSetTargetTemperature(value) {
        let roundedValue = Math.round(value / 5) * 5;
        let level = TEMP_LEVEL_MAP[roundedValue] || 0;

        if (value < MIN_TEMP) level = 0; // 15도 미만은 0레벨(OFF)
        if (value >= MAX_TEMP) level = 7; // 50도 이상은 7레벨

        const packet = this.createControlPacket(level);
        this.log.info(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. **패킷:** ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.tempCharacteristic, packet);

                // HomeKit 상태 업데이트 (쓰기 성공 후)
                const actualTemp = LEVEL_TEMP_MAP[level];
                this.currentState.targetTemp = actualTemp;
                this.currentState.currentTemp = actualTemp;
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = actualTemp;
                }

                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT);

            } catch (error) {
                this.log.error(`[Temp] BLE 쓰기 최종 오류: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가.');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async handleSetTimerHours(value) {
        // 밝기 (0-100)를 시간 (0-10)으로 변환
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) hours = 1; // 0% 초과 밝기는 최소 1시간으로 설정
        if (hours > MAX_TIMER_HOURS) hours = MAX_TIMER_HOURS; // 10시간 초과 방지

        await this.sendTimerCommand(hours);

        this.currentState.timerHours = hours;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

        // HomeKit 상태 업데이트
        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
        this.log.info(`[Timer] 밝기 ${value}% 수신 -> ${hours} 시간 설정 완료. (HomeKit: ${brightnessToSet}%)`);
    }

    async handleTimerSwitch(value) {
        let hoursToSend = 0;
        let brightnessToSet = 0;

        if (value === false) {
            hoursToSend = 0;
            brightnessToSet = 0;
            this.log.info('[Timer] HomeKit 스위치 OFF. 타이머 해제 (0시간).');
        } else {
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                brightnessToSet = BRIGHTNESS_PER_HOUR;
                this.log.info('[Timer] HomeKit 스위치 ON. 시간이 0이므로 1시간(10%)으로 설정.');
            } else {
                brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
                this.log.info(`[Timer] HomeKit 스위치 ON. ${hoursToSend}시간으로 재설정.`);
            }
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHours = hoursToSend;
        this.currentState.timerOn = value;

        // HomeKit 상태 업데이트
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hours) {
        const packet = this.createControlPacket(hours);
        this.log.info(`[Timer] 시간 ${hours} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.timeCharacteristic, packet);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 최종 오류 (시간: ${hours}): ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가.');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }


    initNoble() {
        noble.on('stateChange', (state) => {
            if (state === 'poweredOn') {
                this.log.info('[BLE] Noble 어댑터 켜짐. 스캔 루프 시작.');
                this.startScanningLoop();
            } else {
                this.log.warn(`[BLE] Noble 어댑터 상태 변경: ${state}.`);
                this.disconnectDevice(true);
            }
        });

        noble.on('discover', this.onDiscover.bind(this));
    }

    parseManufacturerData(manufacturerData) {
        if (!manufacturerData) return { isDeviceFound: false, isParingState: false };
        return { isDeviceFound: true, isParingState: true };
    }

    onDiscover(peripheral) {
        if (this.isConnected) return;

        const discoveredAddress = peripheral.address.toLowerCase().replace(/[^0-9a-f]/g, '');

        if (discoveredAddress !== this.macAddress) {
            return;
        }

        const adData = this.parseManufacturerData(peripheral.advertisement.manufacturerData);
        const connectCondition = adData.isDeviceFound;

        if (connectCondition) {
            this.log.info(`[BLE] 매트 장치 발견 (주소: ${peripheral.address}). 연결 시도.`);
            noble.stopScanning();
            this.connectDevice(peripheral);
        }
    }

    startScanningLoop() {
        if (this.isScanningLoopActive) return;
        this.isScanningLoopActive = true;

        const scan = () => {
            if (!this.isConnected && noble.state === 'poweredOn') {
                this.log.debug('[BLE] 스캔 시작. 설정된 서비스 UUID로 장치를 찾습니다.');
                // 10초 주기 중 5초 스캔, 5초 대기
                noble.startScanning([this.serviceUuid], false);

                setTimeout(() => {
                    if (noble.state === 'scanning') {
                        noble.stopScanning();
                        this.log.debug('[BLE] 스캔 멈춤. 다음 주기 대기.');
                    }
                    if (this.isScanningLoopActive) {
                        setTimeout(scan, this.scanInterval - 5000);
                    }
                }, 5000);
            } else if (this.isScanningLoopActive) {
                setTimeout(scan, this.scanInterval);
            }
        };
        scan();
    }


    async connectDevice(peripheral) {
        if (this.isConnected) return;

        this.peripheral = peripheral;

        this.peripheral.removeAllListeners('disconnect');
        this.peripheral.on('disconnect', () => {
            this.log.warn(`[BLE] 매트 연결 해제됨. 재연결 루프를 시작합니다.`);
            this.disconnectDevice(true);
            this.startScanningLoop();
        });

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);
            await this.peripheral.connectAsync();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            this.log.debug('[BLE] 연결 성공 후 안정화를 위해 1000ms 대기...');
            await sleep(1000);

            await this.discoverCharacteristics();

        } catch (error) {
            this.log.error(`[BLE] 매트 연결 실패: ${error.message}. 재스캔 루프를 시작합니다.`);
            this.disconnectDevice(true);
            this.startScanningLoop();
        }
    }

    async discoverCharacteristics() {
        try {
            this.log.debug(`[BLE] 특성 탐색 대상 서비스: ${this.serviceUuid}`);
            const { characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();

            let foundChars = {};
            characteristics.forEach(char => {
                foundChars[char.uuid] = char;
            });

            this.setCharacteristic = foundChars[this.charSetUuid];
            this.tempCharacteristic = foundChars[this.charTempUuid];
            this.timeCharacteristic = foundChars[this.charTimeUuid];

            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info(`[BLE] 모든 필수 특성 (온도:${this.charTempUuid}, 타이머:${this.charTimeUuid}) 발견. 제어 준비 완료.`);

                if (this.setCharacteristic) {
                    this.log.warn(`[Init:${this.charSetUuid}] 설정된 초기화 특성 발견. 초기화 패킷 전송은 현재 비활성화되어 있습니다.`);
                }

                await this.setupNotifications();
                await this.readCurrentState();

            } else {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. (온도:${this.charTempUuid} - ${!!this.tempCharacteristic}, 타이머:${this.charTimeUuid} - ${!!this.timeCharacteristic}) 연결 해제.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 오류: ${error.message}.`);
            this.disconnectDevice(true);
        }
    }

    async setupNotifications() {
        if (this.tempCharacteristic) {
            this.tempCharacteristic.on('data', this.handleTempNotification.bind(this));
            try {
                await this.tempCharacteristic.subscribe();
                this.log.info(`[Notify] 온도/상태 Characteristic (${this.charTempUuid}) 알림 구독 성공.`);
            } catch(error) {
                this.log.error(`[Notify] 알림 구독 실패 (${this.charTempUuid}): ${error.message}`);
            }
        }

        if (this.timeCharacteristic) {
            this.timeCharacteristic.on('data', this.handleTimeNotification.bind(this));
            try {
                await this.timeCharacteristic.subscribe();
                this.log.info(`[Notify] 타이머 Characteristic (${this.charTimeUuid}) 알림 구독 성공.`);
            } catch(error) {
                this.log.error(`[Notify] 알림 구독 실패 (${this.charTimeUuid}): ${error.message}`);
            }
        }
    }

    handleTempNotification(data) {
        if (!data || data.length < 1) {
            this.log.debug('[Notify:Temp] 유효하지 않은 데이터 수신.');
            return;
        }

        const currentLevel = data.readUInt8(0);

        if (currentLevel in LEVEL_TEMP_MAP) {
            const currentTemp = LEVEL_TEMP_MAP[currentLevel];

            this.currentState.targetTemp = currentTemp;
            this.currentState.currentTemp = currentTemp;
            this.currentState.currentHeatingCoolingState = currentLevel > 0
                ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                : this.Characteristic.CurrentHeatingCoolingState.OFF;

            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);

            this.log.debug(`[Notify:Temp] 온도 상태 업데이트 수신: ${data.toString('hex')} (레벨: ${currentLevel}, 온도: ${currentTemp}°C)`);
        } else {
            this.log.debug(`[Notify:Temp] 범위 외 온도 레벨 수신: ${data.toString('hex')} (레벨: ${currentLevel})`);
        }
    }

    handleTimeNotification(data) {
        if (!data || data.length < 1) {
            this.log.debug('[Notify:Time] 유효하지 않은 데이터 수신.');
            return;
        }

        const currentHours = data.readUInt8(0); // 타이머 시간 (0-10)

        if (currentHours <= MAX_TIMER_HOURS) {
            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.debug(`[Notify:Time] 타이머 상태 업데이트 수신: ${data.toString('hex')} (${currentHours} 시간)`);
        } else {
            this.log.debug(`[Notify:Time] 범위 외 타이머 시간 수신: ${data.toString('hex')} (${currentHours} 시간)`);
        }
    }

    async readCurrentState() {
        try {
            // 온도 특성 읽기
            const tempValue = await this.tempCharacteristic.readAsync();
            const currentLevel = tempValue.readUInt8(0);
            const currentTemp = LEVEL_TEMP_MAP[currentLevel] || MIN_TEMP;

            this.currentState.targetTemp = currentTemp;
            this.currentState.currentTemp = currentTemp;
            this.currentState.currentHeatingCoolingState = currentLevel > 0
                ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                : this.Characteristic.CurrentHeatingCoolingState.OFF;
            if (currentLevel > 0) {
                this.currentState.lastHeatTemp = currentTemp;
            }

            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                ? this.Characteristic.TargetHeatingCoolingState.OFF
                : this.Characteristic.TargetHeatingCoolingState.HEAT);

            this.log.debug(`[Sync] 온도 상태 동기화 완료: Level ${currentLevel} -> ${currentTemp}°C.`);

            // 타이머 특성 읽기
            const timeValue = await this.timeCharacteristic.readAsync();
            const currentHours = timeValue.readUInt8(0);

            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.debug(`[Sync] 타이머 상태 동기화 완료: ${currentHours} 시간.`);

        } catch (error) {
            this.log.warn(`[Sync] 초기 상태 읽기 실패: ${error.message}.`);
        }
    }

    disconnectDevice(resetDevice = false) {
        if (this.peripheral && this.isConnected) {
            if (this.tempCharacteristic) {
                this.tempCharacteristic.removeAllListeners('data');
                try {
                    this.tempCharacteristic.unsubscribe();
                    this.log.debug('[Notify] 알림 구독 해제 완료 (온도).');
                } catch(e) {
                    this.log.debug('[Notify] 온도 구독 해제 중 오류 발생: ' + e.message);
                }
            }

            if (this.timeCharacteristic) {
                this.timeCharacteristic.removeAllListeners('data');
                try {
                    this.timeCharacteristic.unsubscribe();
                    this.log.debug('[Notify] 알림 구독 해제 완료 (타이머).');
                } catch(e) {
                    this.log.debug('[Notify] 타이머 구독 해제 중 오류 발생: ' + e.message);
                }
            }

            this.peripheral.disconnect(() => {
                this.log.debug('[BLE] peripheral.disconnect() 완료.');
            });
        }

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        if (resetDevice) {
            this.peripheral = null;
        }
        this.isScanningLoopActive = false;
        this.startScanningLoop();
    }

    getServices() {
        return [
            this.accessoryInformation,
            this.thermostatService,
            this.timerService
        ];
    }
}

noble.Peripheral.prototype.connectAsync = util.promisify(noble.Peripheral.prototype.connect);
noble.Peripheral.prototype.discoverAllServicesAndCharacteristicsAsync = util.promisify(noble.Peripheral.prototype.discoverAllServicesAndCharacteristics);
noble.Characteristic.prototype.write = util.promisify(noble.Characteristic.prototype.write);
noble.Characteristic.prototype.readAsync = util.promisify(noble.Characteristic.prototype.read);
noble.Characteristic.prototype.subscribe = util.promisify(noble.Characteristic.prototype.subscribe);
noble.Characteristic.prototype.unsubscribe = util.promisify(noble.Characteristic.prototype.unsubscribe);


module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};
