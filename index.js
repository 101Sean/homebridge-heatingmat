const noble = require('@abandonware/noble');

// 온도-레벨 매핑 (HomeKit 온도 <-> 매트 레벨)
const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        // 필수 설정값 (MAC Address)
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (!this.macAddress) {
            this.log.error('config.json에 mac_address가 지정되지 않았습니다.');
            return;
        }

        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_time_uuid || '').toLowerCase();

        if (!this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 BLE UUID가 지정되지 않았습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempChar = null;
        this.timeChar = null;

        // 현재 상태 저장 (마지막 설정값을 저장)
        this.currentState = {
            targetTemp: MIN_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false
        };

        this.initServices();
        this.initNoble();
    }

    // BLE 제어 패킷 생성 (4바이트)
    createControlPacket(value) {
        if (value > 255) value = 255;
        const checkByte = 0xFF - value;
        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(value, 0);
        buffer.writeUInt8(checkByte, 1);
        buffer.writeUInt8(0x00, 2);
        buffer.writeUInt8(0x00, 3);
        return buffer;
    }

    // HomeKit 서비스 설정
    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        // 온도 조절기 (Thermostat)
        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        // 목표 온도 (Set/Get)
        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        // 현재 온도 (Get)
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTemp);

        // HEAT 모드 고정
        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setValue(this.Characteristic.TargetHeatingCoolingState.HEAT); // 기본값을 HEAT로 설정

        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.HEAT] // HEAT 모드만 허용
        });

        // ON/OFF 상태 반영 (Get)
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);


        // 타이머 (Lightbulb)
        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        // 타이머 ON/OFF (Set/Get)
        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        // 시간 슬라이더 (Set/Get)
        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * 10);

        this.timerService.setCharacteristic(this.Characteristic.Brightness, 0);
        this.timerService.setCharacteristic(this.Characteristic.On, false);
    }

    // 온도 설정 핸들러
    async handleSetTargetTemperature(value) {
        // HomeKit 온도를 Level (0~7)로 변환
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0;
        if (value > MAX_TEMP) level = 7;

        const packet = this.createControlPacket(level);
        this.log(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. 패킷: ${packet.toString('hex')}`);

        if (this.tempChar) {
            try {
                await this.tempChar.write(packet, false);

                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);

            } catch (error) {
                this.log.error(`[Temp] BLE 쓰기 오류: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가.');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    // 타이머 시간 설정 핸들러
    async handleSetTimerHours(value) {
        let hours = Math.round(value / 10); // 10% 당 1시간 (최대 10시간)
        if (hours > 10) hours = 10;

        await this.sendTimerCommand(hours);

        this.currentState.timerHours = hours;
        this.currentState.timerOn = hours > 0;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.log(`[Timer] 밝기 ${value}% -> ${hours} 시간 설정 완료. (ON 상태: ${this.currentState.timerOn})`);
    }

    // 타이머 ON/OFF 핸들러
    async handleTimerSwitch(value) {
        let hoursToSend = 0;
        let brightnessToSet = 0;

        if (value === false) {
            // OFF -> 0시간 전송
            hoursToSend = 0;
            brightnessToSet = 0;
            this.log('[Timer] 타이머 해제 (0시간).');
        } else {
            // ON -> 현재 밝기 기반으로 시간 재설정 (최소 1시간)
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / 10);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                brightnessToSet = 10; // 최소 10% (1시간)로 설정
                this.log(`[Timer] 타이머 활성화. 시간 설정이 0이므로 1시간(10%)으로 설정.`);
            } else {
                brightnessToSet = hoursToSend * 10;
                this.log(`[Timer] 타이머 재활성화. ${hoursToSend}시간으로 설정.`);
            }
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHours = hoursToSend;
        this.currentState.timerOn = value;

        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    // BLE 타이머 전송
    async sendTimerCommand(hours) {
        const packet = this.createControlPacket(hours);

        if (this.timeChar) {
            try {
                await this.timeChar.write(packet, false);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 오류 (시간: ${hours}): ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가.');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    // BLE 연결 관리 (Noble)
    initNoble() {
        noble.on('stateChange', (state) => {
            this.log(`[BLE] Noble 상태 변경: ${state}`);
            if (state === 'poweredOn') {
                this.log('[BLE] 매트 스캔 시작...');
                //noble.startScanning([this.serviceUuid], false);
                noble.startScanning([], false);
            } else {
                this.log.warn('[BLE] Noble이 블루투스 하드웨어를 사용할 수 없습니다. 상태 확인 필요.');
                noble.stopScanning();
            }
        });

        noble.on('discover', (peripheral) => {
            if (peripheral.address.toLowerCase() === this.macAddress) {
                this.log.info(`[BLE] 매트 장치 발견: ${peripheral.address}`);
                noble.stopScanning();
                this.connectPeripheral(peripheral);
            }
        });

        // 상태가 PoweredOn일 때 즉시 스캔 시작
        if (noble.state === 'poweredOn') {
            this.log('[BLE] Noble 상태가 이미 PoweredOn입니다. 즉시 스캔 시작.');
            noble.startScanning([this.serviceUuid], false);
        }
    }

    connectPeripheral(peripheral) {
        // 연결 해제 시 재스캔 루틴 등록
        peripheral.once('disconnect', () => {
            this.log.warn(`[BLE] 매트 연결 해제됨. 5초 후 재스캔...`);
            this.tempChar = null;
            this.timeChar = null;
            // 5초 후 재스캔 시작
            setTimeout(() => {
                if (noble.state === 'poweredOn') {
                    noble.startScanning([this.serviceUuid], false);
                } else {
                    this.log.error('[BLE] 재스캔 시도 실패: Noble 상태가 PoweredOn이 아닙니다.');
                }
            }, 5000);
        });

        peripheral.connect(async (error) => {
            if (error) {
                this.log.error(`[BLE] 매트 연결 실패: ${error.message}. 5초 후 재스캔...`);
                // 연결 실패 시 재스캔 로직 호출
                peripheral.emit('disconnect');
                return;
            }

            this.log.info(`[BLE] 매트 연결 성공.`);
            try {
                const { services } = await peripheral.discoverAllServicesAndCharacteristics();
                const mainService = services.find(s => s.uuid === this.serviceUuid);
                if (!mainService) {
                    this.log.error(`[BLE] 필수 서비스(${this.serviceUuid})를 찾을 수 없습니다. 연결 해제.`);
                    peripheral.disconnect();
                    return;
                }

                this.tempChar = mainService.characteristics.find(c => c.uuid === this.charTempUuid);
                this.timeChar = mainService.characteristics.find(c => c.uuid === this.charTimeUuid);

                if (this.tempChar && this.timeChar) {
                    this.log.info('[BLE] 모든 필수 특성 발견. 제어 준비 완료.');
                } else {
                    this.log.error(`[BLE] 필수 특성(${this.charTempUuid} 또는 ${this.charTimeUuid}) 중 하나를 찾을 수 없습니다.`);
                    peripheral.disconnect();
                }

            } catch (error) {
                this.log.error(`[BLE] 특성 탐색 오류: ${error.message}`);
                peripheral.disconnect();
            }
        });
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
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};
