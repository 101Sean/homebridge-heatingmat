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

        this.serviceUuid = (config.service_uuid || '').toLowerCase().replace(/-/g, '');
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase().replace(/-/g, '');
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase().replace(/-/g, '');
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase().replace(/-/g, '');

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        this.initPacketHex = config.init_packet_hex;

        // 광고 데이터 기반 필터링 설정
        this.manufacturerId = config.manufacturer_id_hex ? parseInt(config.manufacturer_id_hex, 16) : null;
        this.pairingFlagByteIndex = config.pairing_flag_byte_index === undefined ? null : config.pairing_flag_byte_index;
        this.pairingFlagValue = config.pairing_flag_value === undefined ? null : config.pairing_flag_value;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_timer_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        this.peripheral = null;
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
        this.initNoble();
    }

    // 제어 패킷 생성 로직
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
        this.log.warn('[Init] 초기화 패킷 전송 함수는 현재 연결 끊김 문제 방지를 위해 비활성화되었습니다.');
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
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}).`);

                await sleep(500);

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

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat (Noble)')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

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
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 (15°C)로 설정합니다.');
            await this.handleSetTargetTemperature(MIN_TEMP);

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
                await this.safeWriteValue(this.tempCharacteristic, packet);

                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = value;
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
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) hours = 1;
        if (hours > MAX_TIMER_HOURS) hours = MAX_TIMER_HOURS;

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
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
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
        if (!manufacturerData || this.manufacturerId === null || this.pairingFlagByteIndex === null || this.pairingFlagValue === null) {
            return { isDeviceFound: true, isParingState: true };
        }

        let isDeviceFound = false;
        let isParingState = false;

        if (manufacturerData.length >= 2) {
            const manufacturerId = manufacturerData.readUInt16LE(0);
            isDeviceFound = (manufacturerId & 0xFFFF) === this.manufacturerId;
        }


        if (isDeviceFound && manufacturerData.length > this.pairingFlagByteIndex) {
            const typeByte = manufacturerData.readUInt8(this.pairingFlagByteIndex);
            isParingState = (typeByte & 0x0F) === this.pairingFlagValue;
        } else if (isDeviceFound) {
            this.log.warn(`[BLE] 제조사 ID 일치, 하지만 플래그 인덱스 ${this.pairingFlagByteIndex}가 데이터 길이(${manufacturerData.length})보다 큽니다.`);
        }


        if(this.manufacturerId !== null && !isDeviceFound) {
            return { isDeviceFound: false, isParingState: false };
        }

        return { isDeviceFound, isParingState };
    }

    onDiscover(peripheral) {
        if (this.isConnected) return;

        const discoveredAddress = peripheral.address.toLowerCase().replace(/[^0-9a-f]/g, '');

        if (discoveredAddress !== this.macAddress) {
            return;
        }

        const adData = this.parseManufacturerData(peripheral.advertisement.manufacturerData);

        if (adData.isDeviceFound && adData.isParingState) {
            this.log.info(`[BLE] 매트 장치 발견 (주소: ${peripheral.address}). 장치 ID 및 페어링 상태 확인됨. 연결 시도.`);
            noble.stopScanning();
            this.connectDevice(peripheral);
        } else {
            this.log.debug(`[BLE] 매트 장치(${peripheral.address}) 발견. 연결 조건 불일치 (ID: ${adData.isDeviceFound}, 페어링: ${adData.isParingState}). 건너뜀.`);
        }
    }

    startScanningLoop() {
        if (this.isScanningLoopActive) return;
        this.isScanningLoopActive = true;

        const scan = () => {
            if (!this.isConnected && noble.state === 'poweredOn') {
                this.log.debug('[BLE] 스캔 시작. 설정된 서비스 UUID로 장치를 찾습니다.');
                // noble.startScanning([서비스 UUID], allowDuplicates)
                noble.startScanning([this.serviceUuid], false);

                setTimeout(() => {
                    if (noble.state === 'scanning') {
                        noble.stopScanning();
                        this.log.debug('[BLE] 스캔 멈춤. 다음 주기 대기.');
                    }
                    if (this.isScanningLoopActive) {
                        setTimeout(scan, this.scanInterval);
                    }
                }, 5000); // 5초 스캔 후 중지
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
            this.disconnectDevice();
            this.startScanningLoop(); // 연결이 끊기면 스캔 루프 재시작
        });

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);
            await this.peripheral.connectAsync();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

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

            if (this.charSetUuid) {
                this.setCharacteristic = foundChars[this.charSetUuid];
            }
            this.tempCharacteristic = foundChars[this.charTempUuid];
            this.timeCharacteristic = foundChars[this.charTimeUuid];

            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 특성 (온도, 타이머) 발견. 제어 준비 완료.');

                if (this.setCharacteristic) {
                    this.log.warn('[Init] 설정된 초기화 특성이 있으나, 연결 끊김 문제(ATT 0x0e) 해결을 위해 초기화 패킷 전송을 건너뜁니다.');
                }

                await this.readCurrentState();
            } else {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. (온도: ${!!this.tempCharacteristic}, 타이머: ${!!this.timeCharacteristic}) 연결 해제.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 오류: ${error.message}.`);
            this.disconnectDevice(true);
        }
    }

    async readCurrentState() {
        try {
            const tempValue = await this.tempCharacteristic.readAsync();
            const currentLevel = tempValue.readUInt8(3);
            const currentTemp = LEVEL_TEMP_MAP[currentLevel] || MIN_TEMP;

            this.currentState.targetTemp = currentTemp;
            this.currentState.currentTemp = currentTemp;
            this.currentState.currentHeatingCoolingState = currentLevel > 0
                ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                : this.Characteristic.CurrentHeatingCoolingState.OFF;
            if (currentLevel > 0) {
                this.currentState.lastHeatTemp = currentTemp;
            }

            // HomeKit 상태 업데이트
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                ? this.Characteristic.TargetHeatingCoolingState.OFF
                : this.Characteristic.TargetHeatingCoolingState.HEAT);

            this.log.debug(`[Sync] 온도 상태 동기화 완료: Level ${currentLevel} -> ${currentTemp}°C. (읽기 인덱스 3 사용)`);

            // 타이머 상태 읽기
            const timeValue = await this.timeCharacteristic.readAsync();
            const currentHours = timeValue.readUInt8(3);

            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.debug(`[Sync] 타이머 상태 동기화 완료: ${currentHours} 시간. (읽기 인덱스 3 사용)`);

        } catch (error) {
            this.log.warn(`[Sync] 초기 상태 읽기 실패: ${error.message}.`);
        }
    }

    disconnectDevice(resetDevice = false) {
        if (this.peripheral && this.isConnected) {
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

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};
