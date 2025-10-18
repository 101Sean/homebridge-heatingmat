/**
 * Smart Heating Mat Homebridge Accessory (Final Robust Version)
 * * - BlueZ 캐시 문제 해결을 위한 '연결 재시작' 스위치 추가.
 * - 장치의 'Level FE Level FE' 프로토콜을 사용한 제어 로직 구현.
 * - 연결 성공 시 상태를 읽고 HomeKit에 동기화하는 로직 구현.
 * - 연결 실패 시 장치를 강제로 BlueZ 캐시에서 제거 후 재시도하는 로직 강화.
 */

const NodeBle = require('node-ble');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// 온도와 레벨 매핑 (장치 프로토콜에 맞게 설정)
const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

// 타이머 설정
const MAX_TIMER_HOURS = 10;
const BRIGHTNESS_PER_HOUR = 10;
const SCAN_DURATION_MS = 10000; // 스캔 시간을 10초로 증가 (매트의 15초 광고를 잡기 위해)
const CONNECT_TIMEOUT_MS = 20000; // 연결 시도 타임아웃 20초

const sleep = util.promisify(setTimeout);

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        // 필수 설정 로드
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_time_uuid || '').toLowerCase();

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000; // 재스캔 대기 시간

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정이 누락되었습니다. Mac 주소 및 UUID를 확인하세요.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.adapter = null;
        this.device = null;
        this.gatt = null;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;

        this.isConnected = false;
        this.isScanningLoopActive = false;
        this.isScanning = false;
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

    /**
     * 온도/전원 제어 패킷 생성 (프로토콜: Level | CheckSum | Level | CheckSum)
     * CheckSum = (0xFF - Level) & 0xFF
     */
    createTempPacket(levelL, levelR) {
        // 매트의 양쪽 (좌/우) 온도를 동일하게 설정한다고 가정
        const level = levelL;
        const checkSum = (0xFF - level) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(level, 0);
        buffer.writeUInt8(checkSum, 1);
        buffer.writeUInt8(level, 2); // 우측도 동일 레벨 설정
        buffer.writeUInt8(checkSum, 3);

        return buffer;
    }

    /**
     * 연결 후 장치 활성화(인증)를 위한 패킷.
     * Level 1 (20°C)에 해당하는 '01 FE 01 FE' 사용.
     */
    createAuthPacket() {
        return this.createTempPacket(1, 1);
    }

    /**
     * 타이머 제어 패킷 생성 (프로토콜: Hours | CheckSum | Hours | CheckSum)
     */
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

        // --- 1. Thermostat Service ---
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

        // --- 2. Timer Service (Lightbulb) ---
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

        // --- 3. Reset Switch Service (BlueZ 캐시 강제 리셋용) ---
        this.resetSwitchService = new this.Service.Switch(this.name + ' 연결 재시작', 'reset');

        this.resetSwitchService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleResetSwitch.bind(this))
            .onGet(() => this.currentState.resetSwitchOn);
    }

    async handleResetSwitch(value) {
        if (this.resetInProgress) {
            this.log.warn('[Reset] 재시작 요청 무시됨: 이미 진행 중.');
            // 이미 진행 중이면 HomeKit에 현재 상태(ON)를 다시 업데이트
            this.currentState.resetSwitchOn = true;
            this.resetSwitchService.updateCharacteristic(this.Characteristic.On, true);
            return;
        }

        if (value === true) {
            this.log.warn('=============================================');
            this.log.warn('[Reset] HomeKit 재시작 스위치 ON. 연결 상태 강제 리셋 시작.');
            this.log.warn('=============================================');

            this.resetInProgress = true;
            this.currentState.resetSwitchOn = true;

            // 1. 기존 연결 해제 시도
            await this.disconnectDevice('HomeKit 리셋 명령', true);

            // 2. BlueZ 캐시 제거
            await this.removeDeviceCache();

            // 3. 짧은 대기 후 스위치 상태 복구
            await sleep(5000);
            this.currentState.resetSwitchOn = false;
            this.resetSwitchService.updateCharacteristic(this.Characteristic.On, false);
            this.resetInProgress = false;

            this.log.warn('[Reset] 강제 리셋 완료. 스캔/연결 루프가 자동으로 재개됩니다.');
        } else {
            this.log.debug('[Reset] HomeKit 재시작 스위치 OFF (수동 또는 자동 해제)');
            this.currentState.resetSwitchOn = false;
        }
    }

    async removeDeviceCache() {
        // Mac 주소를 BlueZ 형식 (XX:XX:XX:XX:XX:XX)으로 포맷
        const mac = this.macAddress.toUpperCase().match(/.{1,2}/g).join(':');
        this.log.warn(`[Reset-Cache] BlueZ에서 장치(${mac}) 캐시 제거 시도...`);

        // 1. Disconnect 시도 (연결 해제되지 않은 경우 대비)
        try {
            const { stdout: disconnectStdout } = await exec(`bluetoothctl disconnect ${mac}`);
            this.log.debug(`[Reset-Cache] Disconnect: ${disconnectStdout.trim()}`);
        } catch (e) {
            this.log.debug(`[Reset-Cache] Disconnect 실패 (무시): ${e.message}`);
        }

        // 2. Remove 시도 (캐시 데이터 강제 삭제)
        try {
            const { stdout: removeStdout } = await exec(`bluetoothctl remove ${mac}`);
            this.log.info(`[Reset-Cache] Remove 성공: ${removeStdout.trim()}`);
        } catch (error) {
            this.log.warn(`[Reset-Cache] BlueZ 캐시 제거 최종 실패 (이미 제거되었거나 권한 오류): ${error.message}`);
        }
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 (15°C)로 설정합니다.');
            // MIN_TEMP (15도)는 Level 0에 해당
            await this.handleSetTargetTemperature(MIN_TEMP);
        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            await this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    async handleSetTargetTemperature(value) {
        // 5단위로 반올림하여 레벨 매핑
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;

        // 경계 조건 처리
        if (value < MIN_TEMP) level = 0;
        if (value >= MAX_TEMP) level = 7;

        const packet = this.createTempPacket(level, level);
        this.log.info(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. 최종 패킷: ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                // writeValue를 사용하여 응답을 기다립니다. (대부분의 장치에서 더 안정적)
                await this.tempCharacteristic.writeValue(packet);

                // 상태 업데이트 (통신 성공 시에만)
                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = value;
                }

                // HomeKit에 업데이트 반영
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT);

            } catch (error) {
                this.log.error(`[Temp] BLE 쓰기 오류: ${error.message}`);
                // 통신 실패 시 연결 해제 후 재연결 루프를 시작하도록 유도
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
        this.log.info(`[Timer] 밝기 ${value}% 수신 -> ${hours} 시간 설정 완료.`);
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
            // 연결되어 있거나 리셋 중일 경우 대기
            if (this.isConnected || this.resetInProgress) {
                this.log.debug(`[BLE] 연결 유지 중이거나 리셋 진행 중 (${this.resetInProgress}). 다음 스캔 주기까지 대기.`);
                await sleep(this.scanInterval);
                continue;
            }

            // 연결 필요: 스캔 시작
            this.log.info(`[BLE] 장치 연결 상태가 아님. 스캔 시작 (최대 ${SCAN_DURATION_MS / 1000}초)...`);
            try {
                this.isScanning = true;
                await this.adapter.startDiscovery();

                await sleep(SCAN_DURATION_MS);

                await this.adapter.stopDiscovery();
                this.isScanning = false;

                const targetAddress = this.macAddress.toUpperCase();
                const deviceAddresses = await this.adapter.devices();
                let targetDevice = null;

                for (const address of deviceAddresses) {
                    const normalizedAddress = address.toUpperCase().replace(/:/g, '');
                    const normalizedTargetAddress = targetAddress.replace(/:/g, '');

                    if (normalizedAddress === normalizedTargetAddress) {
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
                this.log.error(`[BLE] 스캔/연결 시도 오류: ${error.message}`);
                // 스캔/연결 오류 발생 시 장치를 초기화하고 재시도
                this.disconnectDevice(`스캔 루프 오류: ${error.message}`, true);
                if (this.isScanning) {
                    try { await this.adapter.stopDiscovery(); } catch (e) { /* 무시 */ }
                    this.isScanning = false;
                }
            }

            // 다음 스캔 주기까지 대기
            await sleep(this.scanInterval);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected || this.resetInProgress) { return; }

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);

            // 연결 타임아웃 적용하여 무한 대기 방지
            await this.device.connect({ transport: 'le', timeout: CONNECT_TIMEOUT_MS });
            this.isConnected = true;
            this.log.debug(`[BLE] 장치 연결 성공! GATT 초기화 단계로 진입.`);

            // 연결 해제 이벤트 리스너 설정 (외부 요인으로 연결 끊길 때 자동 복구 유도)
            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 매트 연결 해제됨 (외부 요인). 재연결 루프를 시작합니다.`);
                this.disconnectDevice('외부 연결 끊김', true);
            });

            this.gatt = await this.device.gatt();
            this.log.info(`[BLE] GATT 서비스 탐색 시작.`);

            const service = await this.gatt.getPrimaryService(this.serviceUuid);

            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);

            if (!this.tempCharacteristic || !this.timeCharacteristic) {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. 연결 해제.`);
                this.disconnectDevice('특성 누락', true);
                return;
            }

            this.log.info('[BLE] 모든 필수 특성 발견. 제어 준비 완료.');

            // --- 인증 및 상태 동기화 ---
            const authPacket = this.createAuthPacket();
            this.log.warn(`[AUTH] 인증 패킷 전송 시도: ${authPacket.toString('hex')}`);
            await this.tempCharacteristic.writeValue(authPacket);

            this.log.info('[AUTH] 인증 패킷 전송 성공. HomeKit 상태 동기화 시작.');

            // 1. 장치에서 현재 상태를 읽어 HomeKit에 동기화
            await this.readCurrentState();

            // 2. 연결이 성공했을 때, 장치의 현재 전원 상태에 따라 마지막 설정 온도로 복구 시도
            if (this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.HEAT) {
                await this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
            } else {
                await this.handleSetTargetTemperature(MIN_TEMP); // 15도 (Off)
            }

        } catch (error) {
            const errorMessage = error.message || String(error);
            this.log.error(`[BLE] 매트 연결/인증/동기화 실패: ${errorMessage}.`);

            // BlueZ 관련 연결 실패로 추정되면 캐시 제거 시도
            if (errorMessage.includes('le-connection-abort-by-local') || errorMessage.includes('Operation failed') || errorMessage.includes('Disconnected') || errorMessage.includes('Timed out')) {
                this.log.warn('[ERROR-FIX] BlueZ 캐시 문제 또는 통신 문제로 추정. OS 캐시를 지우고 재시도합니다.');
                await this.removeDeviceCache();
            }

            this.disconnectDevice(`연결/인증 실패: ${errorMessage}`, true);
        }
    }

    async readCurrentState() {
        try {
            // 1. 온도 특성 읽기
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

            // HomeKit 업데이트
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                ? this.Characteristic.TargetHeatingCoolingState.OFF
                : this.Characteristic.TargetHeatingCoolingState.HEAT);

            this.log.info(`[Sync] 온도 동기화 완료: Level ${currentLevel} -> ${currentTemp}°C. (수신: ${tempValue.toString('hex')})`);

            // 2. 타이머 특성 읽기
            const timeValue = await this.timeCharacteristic.readValue();
            const currentHours = timeValue.readUInt8(0);

            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            // HomeKit 업데이트
            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.info(`[Sync] 타이머 동기화 완료: ${currentHours} 시간. (수신: ${timeValue.toString('hex')})`);

        } catch (error) {
            this.log.warn(`[Sync] 초기 상태 읽기 실패 (READ 오류): ${error.message}`);
            this.disconnectDevice(`상태 읽기 실패: ${error.message}`, true);
        }
    }

    async disconnectDevice(reason = '알 수 없는 이유', resetDevice = false) {
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
            try {
                // node-ble은 장치가 이미 끊어져도 .isConnected()가 오류를 낼 수 있음.
                // 안전을 위해 disconnect()를 직접 호출하고 에러를 무시합니다.
                await deviceToDisconnect.disconnect().catch(e => {
                    if (!e.message.includes('not connected')) {
                        this.log.debug(`[BLE] 안전한 연결 해제 중 예상치 못한 오류 (무시): ${e.message}`);
                    }
                });
                this.log.warn('[BLE] 장치 안전하게 연결 해제됨.');
            } catch (e) {
                this.log.warn(`[BLE] 연결 해제 최종 실패 (무시): ${e.message}`);
            }
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
