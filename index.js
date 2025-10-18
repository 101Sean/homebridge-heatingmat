const NodeBle = require('node-ble');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

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
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_time_uuid || '').toLowerCase();

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정이 누락되었습니다. Mac 주소 및 UUID를 확인하세요.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.device = null;
        this.gatt = null;

        this.isConnected = false;

        this.isScanningLoopActive = false;
        this.resetInProgress = false;

        this.currentState = {
            targetTemp: MIN_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP,
            resetSwitchOn: false
        };

        this.initServices();
        this.initNodeBle();
    }

    createTempPacket(levelL, levelR) {
        const level = levelL;
        const checkSum = (0xFF - level) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(level, 0);
        buffer.writeUInt8(checkSum, 1);
        buffer.writeUInt8(level, 2);
        buffer.writeUInt8(checkSum, 3);

        return buffer;
    }

    // Level 1 (15°C) 패킷을 인증 패킷으로 사용 (01 FE 01 FE)
    createAuthPacket() {
        return this.createTempPacket(1, 1);
    }


    createTimerPacket(hoursL, hoursR) {
        const checkSumL = (0xFF - hoursL) & 0xFF;
        const checkSumR = (0xFF - hoursR) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(hoursL, 0);
        buffer.writeUInt8(checkSumL, 1);
        buffer.writeUInt8(hoursR, 2);
        buffer.writeUInt8(checkSumR, 3);

        return buffer;
    }

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'BLE Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat Protocol V2')
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

        this.resetSwitchService = new this.Service.Switch(this.name + ' 연결 재시작', 'reset');

        this.resetSwitchService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleResetSwitch.bind(this))
            .onGet(() => this.currentState.resetSwitchOn);
    }

    async handleResetSwitch(value) {
        if (this.resetInProgress) {
            this.log.warn('[Reset] 재시작 요청 무시됨: 이미 진행 중.');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.BUSY);
        }

        if (value === true) {
            this.log.warn('=============================================');
            this.log.warn('[Reset] HomeKit 재시작 스위치 ON. 연결 상태 강제 리셋 시작.');
            this.log.warn('=============================================');

            this.resetInProgress = true;
            this.currentState.resetSwitchOn = true;

            this.disconnectDevice('HomeKit 리셋 명령', true);

            await this.removeDeviceCache();

            await sleep(5000);
            this.currentState.resetSwitchOn = false;
            this.resetSwitchService.updateCharacteristic(this.Characteristic.On, false);
            this.resetInProgress = false;

            this.log.warn('[Reset] 강제 리셋 완료. 새로운 스캔/연결 시도를 시작합니다.');

        } else {
            this.log.debug('[Reset] HomeKit 재시작 스위치 OFF (수동 또는 자동 해제)');
            this.currentState.resetSwitchOn = false;
        }
    }

    async removeDeviceCache() {
        const mac = this.macAddress.toUpperCase().match(/.{1,2}/g).join(':');
        this.log.warn(`[Reset-Cache] BlueZ에서 장치(${mac}) 캐시 제거 시도...`);
        try {
            // bluetoothctl을 사용하여 장치 연결 해제 및 제거 시도
            const { stdout, stderr } = await exec(`bluetoothctl disconnect ${mac} && bluetoothctl remove ${mac}`);
            this.log.info(`[Reset-Cache] bluetoothctl 결과: ${stdout.trim()}`);
            if (stderr) this.log.warn(`[Reset-Cache] bluetoothctl stderr: ${stderr.trim()}`);
        } catch (error) {
            this.log.error(`[Reset-Cache] BlueZ 캐시 제거 실패 (일반적일 수 있음): ${error.message}`);
        }
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

        const packet = this.createTempPacket(level, level);
        this.log.info(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. 최종 패킷: ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                // 확보된 특성 객체의 writeValue 사용
                await this.tempCharacteristic.writeValue(packet);

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
                this.log.error(`[Temp] BLE 쓰기 오류: ${error.message}`);
                this.disconnectDevice(`특성 쓰기 실패: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가. (재연결 시도 중)');
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
        const packet = this.createTimerPacket(hours, hours);
        this.log.info(`[Timer] 시간 ${hours} 명령 전송 시도. 최종 패킷: ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                // 확보된 특성 객체의 writeValue 사용
                await this.timeCharacteristic.writeValue(packet);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 오류 (시간: ${hours}): ${error.message}`);
                this.disconnectDevice(`타이머 쓰기 실패: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }


    initNodeBle() {
        this.initializeBleAdapter();
    }

    async initializeBleAdapter() {
        try {
            this.log.info('[BLE] node-ble 초기화 및 어댑터 설정 시작.');
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
            this.log.error(`[BLE] node-ble 초기화 실패. BlueZ 서비스 확인: ${error.message}`);
        }
    }

    async startScanningLoop() {
        if (!this.adapter || this.isScanningLoopActive) { return; }

        this.isScanningLoopActive = true;
        this.log.info('[BLE] 백그라운드 스캔/연결 루프 시작.');

        while (this.isScanningLoopActive) {
            if (!this.isConnected && !this.resetInProgress) {
                this.log.debug('[BLE] 장치 연결 상태가 아님. 스캔 시작...');
                try {
                    await this.adapter.startDiscovery();
                    const targetAddress = this.macAddress.toUpperCase();
                    await sleep(5000);
                    await this.adapter.stopDiscovery();

                    const deviceAddresses = await this.adapter.devices();
                    let targetDevice = null;

                    for (const address of deviceAddresses) {
                        const normalizedAddress = address.toUpperCase().replace(/:/g, '');
                        if (normalizedAddress === targetAddress) {
                            targetDevice = await this.adapter.getDevice(address);
                            this.log.info(`[BLE] 매트 장치 발견: ${address}`);
                            break;
                        }
                    }

                    if (targetDevice) {
                        this.device = targetDevice;
                        await this.connectDevice();
                    } else {
                        this.log.info(`[BLE] 매트 장치(${targetAddress})를 찾지 못했습니다. ${deviceAddresses.length}개 장치 탐색됨.`);
                    }

                } catch (error) {
                    this.log.error(`[BLE] 스캔 오류: ${error.message}`);
                    this.disconnectDevice(`스캔 루프 오류: ${error.message}`, true);
                }
            } else {
                this.log.debug(`[BLE] 연결 유지 중이거나 리셋 진행 중 (${this.resetInProgress}). 다음 스캔 주기까지 대기.`);
            }

            await sleep(this.scanInterval);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected || this.resetInProgress) { return; }

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);

            // transport: 'le' (Low Energy)를 명시하고, timeout을 늘려서 안정성을 높입니다.
            await this.device.connect({ transport: 'le', timeout: 10000 });

            this.isConnected = true;

            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 매트 연결 해제됨 (외부 요인). 재연결 루프를 시작합니다.`);
                this.disconnectDevice('외부 연결 끊김', true);
            });

            const authPacket = this.createAuthPacket();
            this.gatt = await this.device.gatt();

            // ★★★ NEW LOGIC: Discover characteristics BEFORE authentication write ★★★
            this.log.warn(`[AUTH] 연결 성공! GATT 탐색 시작 및 인증 시도.`);
            this.log.info(`[BLE] 특성 탐색 시작: 서비스(${this.serviceUuid}), 특성(온도:${this.charTempUuid}, 타이머:${this.charTimeUuid})`);

            const service = await this.gatt.getPrimaryService(this.serviceUuid);

            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);

            if (!this.tempCharacteristic || !this.timeCharacteristic) {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. 연결 해제.`);
                this.disconnectDevice('특성 누락', true);
                return;
            }

            this.log.info('[BLE] 모든 필수 특성 발견. 제어 준비 완료.');

            // Use the discovered characteristic object for the authentication write
            this.log.warn(`[AUTH] 특성 발견 완료. 인증 패킷 전송 시도: ${authPacket.toString('hex')}`);
            await this.tempCharacteristic.writeValue(authPacket);

            this.log.info('[AUTH] 인증 패킷 전송 성공. 매트가 셧다운되지 않았다면, 다음 단계로 이동합니다.');

            // Authentication succeeded, proceed to state synchronization
            await this.handleSetTargetTemperature(MIN_TEMP); // OFF 명령을 다시 보내 강제로 끔 (혹시 15도로 켜졌다면)
            await this.readCurrentState();

        } catch (error) {
            this.log.error(`[BLE] 매트 연결 또는 인증 실패: ${error.message}. 재스캔 루프를 시작합니다.`);
            // 연결 실패 시 장치 캐시를 지우고 재시도
            this.disconnectDevice(`연결/인증 실패: ${error.message}`, true);
        }
    }

    // discoverCharacteristics 함수는 connectDevice에 통합되어 제거되었습니다.

    async readCurrentState() {
        try {
            const tempValue = await this.tempCharacteristic.readValue();
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

            this.log.info(`[Sync] 온도 동기화 완료: Level ${currentLevel} -> ${currentTemp}°C. (수신: ${tempValue.toString('hex')})`);

            const timeValue = await this.timeCharacteristic.readValue();
            const currentHours = timeValue.readUInt8(0);

            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.info(`[Sync] 타이머 동기화 완료: ${currentHours} 시간. (수신: ${timeValue.toString('hex')})`);

        } catch (error) {
            this.log.warn(`[Sync] 초기 상태 읽기 실패 (READ 오류 또는 데이터 해석 오류): ${error.message}`);
            this.disconnectDevice(`상태 읽기 실패: ${error.message}`, true);
        }
    }

    disconnectDevice(reason = '알 수 없는 이유', resetDevice = false) {
        const deviceToDisconnect = this.device;

        this.log.warn(`[BLE] 연결 해제 처리 시작. 이유: ${reason}`);

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.gatt = null;

        if (resetDevice) {
            this.device = null;
        }

        if (deviceToDisconnect) {
            deviceToDisconnect.isConnected().then(connected => {
                if(connected) {
                    deviceToDisconnect.disconnect()
                        .then(() => this.log.warn('[BLE] 장치 안전하게 연결 해제됨.'))
                        .catch(e => this.log.warn(`[BLE] 안전한 연결 해제 실패: ${e.message}`));
                }
            }).catch(() => {});
        }
    }

    getServices() {
        return [
            this.accessoryInformation,
            this.thermostatService,
            this.timerService,
            this.resetSwitchService
        ];
    }
}

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};
