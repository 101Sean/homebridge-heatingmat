const NodeBle = require('node-ble');
const util = require('util');

// 상수 (디컴파일 및 요구 사항 반영)
const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

// 타이머 범위 (1~15시간, 0시간 시 OFF)
const MAX_TIMER_HOURS = 15;
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
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase();
        this.initPacketHex = config.init_packet_hex || 'a55aFFFF'; // 기본값 설정

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.isConnected = false;
        this.isScanningLoopActive = false;

        this.currentState = {
            targetTemp: MIN_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle();
    }

    /**
     * 최종 쓰기 패킷 형태: [Level, Checksum, Level, Checksum] (4바이트)
     * 장치가 단일 제어 모드이지만, 패킷 자체는 양쪽을 모두 채워야 유효한 명령으로 인식될 가능성에 기반
     */
    createControlPacket(value) {
        const dataByte = value; // Level
        const checkSum = (0xFF - dataByte) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(dataByte, 0); // Left Data (Level)
        buffer.writeUInt8(checkSum, 1); // Left Checksum
        buffer.writeUInt8(dataByte, 2); // RIGHT Data (Level)
        buffer.writeUInt8(checkSum, 3); // RIGHT Checksum

        return buffer;
    }

    // 쓰기 재시도 및 연결 해제 로직 유지
    async safeWriteValue(characteristic, packet, maxRetries = 3, delayMs = 300) {
        if (!this.isConnected) {
            throw new Error("Device not connected.");
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.writeValue(packet);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}).`);
                await sleep(500); // 쓰기 후 안정화 딜레이
                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}): ${error.message}`);
                if (attempt === maxRetries) {
                    this.log.error(`[BLE Write] 최종 쓰기 실패. 연결 해제 및 재시도 루프 시작.`);
                    this.disconnectDevice();
                    throw error;
                }
                await sleep(delayMs);
            }
        }
    }

    // 초기화 패킷 전송 (FF10 특성 사용)
    async sendInitializationPacket() {
        if (!this.setCharacteristic || !this.isConnected || !this.initPacketHex) {
            this.log.warn('[Init] 초기화 조건 불충족. 건너뛰기.');
            return;
        }

        try {
            const initPacket = Buffer.from(this.initPacketHex, 'hex');
            this.log.info(`[Init] 초기화 패킷 전송 시도: ${this.initPacketHex}`);
            await this.safeWriteValue(this.setCharacteristic, initPacket, 3, 500); // FF10에 초기화 패킷 전송

            this.log.info('[Init] 초기화 패킷 전송 성공.');
        } catch (error) {
            this.log.error(`[Init] 초기화 패킷 전송 오류: ${error.message}`);
            this.disconnectDevice(true);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        // 온도 특성 설정
        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
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
            .onGet(() => {
                return this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        // 타이머 특성 설정
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
        // 전원 OFF 시 Level 0 (15°C) 설정
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 (15°C)로 설정합니다.');
            await this.handleSetTargetTemperature(MIN_TEMP);

            // 전원 ON 시 마지막 설정 온도로 복구
        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            await this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    async handleSetTargetTemperature(value) {
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0;
        if (value >= MAX_TEMP) level = 7;

        const packet = this.createControlPacket(level);
        this.log.info(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. **패킷:** ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                // FF20 특성(온도)에 쓰기 명령 전송
                await this.safeWriteValue(this.tempCharacteristic, packet);

                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = value;
                }

                // HomeKit 상태 업데이트
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT);

            } catch (error) {
                this.log.error(`[Temp] BLE 쓰기 오류: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가. (재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        // 0% 초과, 1시간 미만은 1시간으로 설정
        if (value > 0 && hours === 0) {
            hours = 1;
        }

        if (hours > MAX_TIMER_HOURS) {
            hours = MAX_TIMER_HOURS;
        }

        // 0시간일 시 앱의 로직에 따라 전원 OFF 명령을 추가
        if (hours === 0) {
            this.log.info('[Timer] 타이머 0시간 설정 수신. 전원을 OFF 합니다.');
            await this.handleSetTargetTemperature(MIN_TEMP);
        }

        await this.sendTimerCommand(hours);

        this.currentState.timerHours = hours;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

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
            // 타이머 스위치 OFF 시 전원 OFF 명령을 추가
            await this.handleSetTargetTemperature(MIN_TEMP);

        } else {
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                brightnessToSet = BRIGHTNESS_PER_HOUR;
                this.log.info('[Timer] HomeKit 스위치 ON. 시간이 0이므로 1시간으로 설정.');
            } else {
                brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
                this.log.info(`[Timer] HomeKit 스위치 ON. ${hoursToSend}시간으로 재설정.`);
            }
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHours = hoursToSend;
        this.currentState.timerOn = value;

        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hours) {
        const packet = this.createControlPacket(hours);
        this.log.info(`[Timer] 시간 ${hours} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                // FF30 특성(타이머)에 쓰기 명령 전송
                await this.safeWriteValue(this.timeCharacteristic, packet);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 오류 (시간: ${hours}): ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    // ... (initNodeBle, initializeBleAdapter, startScanningLoop, connectDevice, readCurrentState, disconnectDevice, getServices 함수는 동일)


    //---------------------------------------------------------
    // 최종 수정: Notification 활성화 후 초기화 패킷 전송 로직
    //---------------------------------------------------------
    async discoverCharacteristics() {
        if (!this.device) return;

        try {
            this.log.debug(`[BLE] 특성 탐색 대상 서비스: ${this.serviceUuid}`);

            // 연결 직후 안정화 딜레이 유지
            await sleep(2000);

            const gatt = await this.device.gatt();

            const service = await gatt.getPrimaryService(this.serviceUuid);
            this.log.debug(`[BLE] 서비스 ${this.serviceUuid} 발견 성공.`);

            if (this.charSetUuid) {
                this.setCharacteristic = await service.getCharacteristic(this.charSetUuid);
            }
            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);


            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 특성 (온도, 타이머) 발견. 제어 준비 완료.');

                // 1. Notification 활성화 (FF20, FF30) (앱의 enableTXNotification 역할)
                try {
                    this.log.info('[BLE] 온도 및 타이머 특성 Notification 활성화 시도...');

                    // 온도 핸들러
                    await this.tempCharacteristic.startNotifications();
                    this.tempCharacteristic.on('valuechanged', (data) => {
                        this.log.debug(`[BLE Notify] 온도 데이터 수신: ${data.toString('hex')}`);
                        const currentLevel = Math.max(data.readUInt8(3), data.readUInt8(1));
                        const currentTemp = LEVEL_TEMP_MAP[currentLevel] || MIN_TEMP;
                        if (this.currentState.currentTemp !== currentTemp) {
                            this.currentState.currentTemp = currentTemp;
                            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, currentTemp);
                            this.log.info(`[Notify] 실시간 온도 업데이트: ${currentTemp}°C`);
                        }
                    });

                    // 타이머 핸들러
                    await this.timeCharacteristic.startNotifications();
                    this.timeCharacteristic.on('valuechanged', (data) => {
                        this.log.debug(`[BLE Notify] 타이머 데이터 수신: ${data.toString('hex')}`);
                        const currentHours = Math.max(data.readUInt8(3), data.readUInt8(1));

                        if (this.currentState.timerHours !== currentHours) {
                            this.currentState.timerHours = currentHours;
                            this.currentState.timerOn = currentHours > 0;

                            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
                            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);
                            this.log.info(`[Notify] 실시간 타이머 업데이트: ${currentHours}시간`);
                        }
                    });

                    this.log.info('[BLE] Notification 활성화 성공.');
                    await sleep(1000); // Notification 활성화 후 안정화 대기

                } catch (e) {
                    this.log.error(`[BLE Notify] Notification 활성화 실패: ${e.message}.`);
                    // Notification 실패 시에도 다음 단계는 진행합니다.
                }

                // 2. 초기화 패킷 전송 (앱의 onDescriptorWrite 완료 후 로직)
                if (this.setCharacteristic && this.initPacketHex) {
                    this.log.info('[Init] Notification 활성화 완료. 초기화 패킷을 전송합니다.');
                    await this.sendInitializationPacket(); // a55aFFFF 패킷 전송
                    await sleep(1000);
                }

                // 3. 상태 읽기
                await this.readCurrentState();
            } else {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. 연결 해제.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 오류: ${error.message}.`);
            this.disconnectDevice(true);
        }
    }


    // ... (나머지 클래스 메소드 및 module.exports는 동일)
}

// 이 부분은 class HeatingMatAccessory 밖에서 정의되어야 합니다. (파일의 하단)
//---------------------------------------------------------
// Homebridge 플러그인 등록
//---------------------------------------------------------

// readCurrentState, disconnectDevice, getServices 등은 위 코드에서 생략되었으나,
// 이전 코드에 포함되어 있다면 그대로 유지되어야 합니다.

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};