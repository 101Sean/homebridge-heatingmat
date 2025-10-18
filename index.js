const NodeBle = require('node-ble');
const util = require('util');

// 온도-레벨 매핑 (HomeKit 온도 <-> 매트 레벨)
const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15; // Level 0에 해당
const MAX_TEMP = 50; // Level 7에 해당
const DEFAULT_HEAT_TEMP = 30; // 전원 ON 시 복구할 기본 온도 (Level 3)

// 타이머 로직 상수 (사용자 요청 반영: 10% = 1시간, 100% = 10시간)
const MAX_TIMER_HOURS = 10;
const BRIGHTNESS_PER_HOUR = 10;

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        // 필수 설정값 (MAC Address 및 UUID)
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_time_uuid || '').toLowerCase();

        // node-ble에서 어댑터 ID 설정이 필요한 경우 (기본값 'hci0')
        this.adapterId = config.adapter_id || 'hci0';
        // 스캔 재시도 간격 설정 (기본값 15초)
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_time_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null; // node-ble 특성 객체
        this.timeCharacteristic = null; // node-ble 특성 객체
        this.device = null; // node-ble 장치 객체
        this.adapter = null; // node-ble 어댑터 객체
        this.isConnected = false;

        // 스캔 루프 상태를 제어하기 위한 플래그 (중복 스캔 방지 목적)
        this.isScanningLoopActive = false;

        // 현재 상태 저장
        this.currentState = {
            targetTemp: MIN_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle(); // node-ble 초기화 및 연결 루프 시작
    }

    // BLE 제어 패킷 생성
    createControlPacket(value) {
        const level = Math.min(Math.max(0, value), 7);
        const checkByte = 0xFF - level; // 역방향 유효성 검사 바이트

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(level, 0);
        buffer.writeUInt8(checkByte, 1);
        buffer.writeUInt8(0x00, 2);
        buffer.writeUInt8(0x00, 3);

        return buffer;
    }

    // HomeKit 서비스 설정 및 핸들러 연결
    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        // TargetTemperature (온도 설정)
        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        // CurrentTemperature (현재 설정 온도)
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTemp);

        // TargetHeatingCoolingState (ON/OFF 스위치 역할)
        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.OFF, this.Characteristic.TargetHeatingCoolingState.HEAT]
        });
        targetHeatingCoolingStateCharacteristic
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => {
                return this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.currentState.TargetHeatingCoolingState.HEAT;
            });

        // CurrentHeatingCoolingState (현재 상태)
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);


        // 타이머 (Lightbulb)
        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        // Timer ON/OFF
        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        // Timer Hours (Brightness 슬라이더)
        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * BRIGHTNESS_PER_HOUR);

        this.timerService.setCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * BRIGHTNESS_PER_HOUR);
        this.timerService.setCharacteristic(this.Characteristic.On, this.currentState.timerOn);
    }

    // 전원 ON/OFF 명령 처리 핸들러
    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 (15°C)로 설정합니다.');
            await this.handleSetTargetTemperature(MIN_TEMP); // 15°C = Level 0 전송

        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            await this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    // 온도 설정 핸들러
    async handleSetTargetTemperature(value) {
        // HomeKit 온도를 Level로 변환
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0;
        if (value >= MAX_TEMP) level = 7;

        const packet = this.createControlPacket(level);
        this.log.info(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. 패킷: ${packet.toString('hex')}`);


        if (this.tempCharacteristic && this.isConnected) {
            try {
                // node-ble 쓰기 명령 (response 없이)
                await this.tempCharacteristic.write(packet, false);

                // 상태 업데이트
                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = value;
                }

                // HomeKit 업데이트
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT);

            } catch (error) {
                this.log.error(`[Temp] BLE 쓰기 오류: ${error.message}`);
                // 쓰기 실패 시 재연결 루틴은 메인 루프에 맡기고 현재 명령은 실패 처리
                this.disconnectDevice();
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            // 불필요한 즉각적인 connectDevice() 호출을 제거하고, 루프에 맡김
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    // 타이머 시간 설정 핸들러 (밝기 슬라이더)
    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        // 1% ~ 9% 밝기인 경우 (hours == 0)에도 최소 시간 1시간으로 설정
        if (value > 0 && hours === 0) {
            hours = 1;
        }

        if (hours > MAX_TIMER_HOURS) {
            hours = MAX_TIMER_HOURS;
        }

        await this.sendTimerCommand(hours);

        this.currentState.timerHours = hours;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
        this.log.info(`[Timer] 밝기 ${value}% 수신 -> ${hours} 시간 설정 완료. (HomeKit: ${brightnessToSet}%)`);
    }

    // 타이머 ON/OFF 핸들러
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
                // OFF 상태에서 ON 명령을 받았는데 시간이 0일 경우, 최소 1시간으로 설정
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

    // BLE 타이머 전송
    async sendTimerCommand(hours) {
        const packet = this.createControlPacket(hours);
        this.log.info(`[Timer] 시간 ${hours} 명령 전송 시도. 패킷: ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                // node-ble 쓰기 명령 (response 없이)
                await this.timeCharacteristic.write(packet, false);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 오류 (시간: ${hours}): ${error.message}`);
                this.disconnectDevice();
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            // 불필요한 즉각적인 connectDevice() 호출을 제거하고, 루프에 맡김
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    initNodeBle() {
        this.initializeBleAdapter();
    }

    async initializeBleAdapter() {
        try {
            this.log.info('[BLE] node-ble createBluetooth()를 사용하여 BLE 초기화를 시도합니다.');

            const { bluetooth } = NodeBle.createBluetooth();

            let adapter;
            if (this.adapterId && this.adapterId !== 'hci0') {
                adapter = await bluetooth.getAdapter(this.adapterId);
            } else {
                adapter = await bluetooth.defaultAdapter();
            }

            this.adapter = adapter;
            this.log.info(`[BLE] 어댑터(${this.adapterId}) 초기화 성공. 스캔 루프 시작.`);
            this.startScanningLoop();
        } catch (error) {
            this.log.error(`[BLE] node-ble 초기화 실패. BlueZ 서비스가 실행 중인지, 혹은 권한이 있는지 확인하세요: ${error.message}`);
        }
    }

    async startScanningLoop() {
        if (!this.adapter || this.isScanningLoopActive) {
            this.log.debug('[BLE] 스캔 루프 시작 조건을 만족하지 못했습니다. (어댑터 없음 또는 이미 실행 중)');
            return;
        }

        this.isScanningLoopActive = true;
        this.log.info('[BLE] 백그라운드 스캔/연결 루프를 시작합니다.');

        while (this.isScanningLoopActive) {
            if (!this.isConnected) {
                this.log.debug('[BLE] 장치 연결 상태가 아님. 스캔 시작...');
                try {
                    await this.adapter.startDiscovery();

                    const targetAddress = this.macAddress.toUpperCase();
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await this.adapter.stopDiscovery();

                    const devices = await this.adapter.getDevices();
                    this.device = devices.find(d => d.address === targetAddress);

                    if (this.device) {
                        this.log.info(`[BLE] 매트 장치 발견: ${this.device.address}`);
                        await this.connectDevice();
                    } else {
                        this.log.debug(`[BLE] 매트 장치(${targetAddress})를 찾지 못했습니다.`);
                    }

                } catch (error) {
                    this.log.error(`[BLE] 스캔 오류: ${error.message}`);
                }
            } else {
                this.log.debug('[BLE] 연결 상태 유지 중. 다음 스캔 주기까지 대기합니다.');
            }

            await new Promise(resolve => setTimeout(resolve, this.scanInterval));
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected) {
            return;
        }

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);
            await this.device.connect();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            // 연결 끊김 이벤트 처리
            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 매트 연결 해제됨. 재연결 루프를 시작합니다.`);
                this.disconnectDevice();
            });

            // 특성 탐색 및 설정
            await this.discoverCharacteristics();

        } catch (error) {
            this.log.error(`[BLE] 매트 연결 실패: ${error.message}. 재스캔 루프를 시작합니다.`);
            // 연결 실패 시 장치 객체까지 초기화하여 다음 루프에서 재탐색하도록 합니다.
            this.disconnectDevice(true);
        }
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.device.gatt();
            const service = await gatt.getPrimaryService(this.serviceUuid);

            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);

            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 특성 발견. 제어 준비 완료.');
            } else {
                this.log.error(`[BLE] 필수 특성(${this.charTempUuid} 또는 ${this.charTimeUuid}) 중 하나를 찾을 수 없습니다. 연결 해제.`);
                await this.device.disconnect();
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 오류: ${error.message}`);
            await this.device.disconnect();
        }
    }

    disconnectDevice(resetDevice = false) {
        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        if (this.device && this.device.isConnected) {
            this.device.disconnect().catch(e => this.log.warn(`[BLE] 안전한 연결 해제 실패: ${e.message}`));
        }

        if (resetDevice) {
            this.device = null;
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
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};
