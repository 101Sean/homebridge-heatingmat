const NodeBle = require('node-ble');
const util = require('util');

const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 }; // Level 7: 50
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

const MAX_TIMER_HOURS = 10;
const BRIGHTNESS_PER_HOUR = 10;
const SCAN_DURATION_MS = 10000;
const INITIAL_CONNECT_DELAY_MS = 2000;

const CONNECT_TIMEOUT_MS = 5000;
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 300;

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
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_time_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.device = null;
        this.adapter = null;
        this.isConnected = false;
        this.isScanningLoopActive = false;

        this.currentState = {
            targetTempL: MIN_TEMP,
            targetTempR: MIN_TEMP,
            currentTempL: MIN_TEMP,
            currentTempR: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHoursL: 0,
            timerHoursR: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle();
    }

    createTempPacket(levelL, levelR) {
        const checkSumL = (0xFF - levelL) & 0xFF;
        const checkSumR = (0xFF - levelR) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(levelL, 0);
        buffer.writeUInt8(checkSumL, 1);
        buffer.writeUInt8(levelR, 2);
        buffer.writeUInt8(checkSumR, 3);

        return buffer;
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
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat (Single Zone)')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTempL);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTempL);

        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.OFF, this.Characteristic.TargetHeatingCoolingState.HEAT]
        });
        targetHeatingCoolingStateCharacteristic
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => {
                const isOn = this.currentState.targetTempL > MIN_TEMP;
                return isOn
                    ? this.Characteristic.TargetHeatingCoolingState.HEAT
                    : this.Characteristic.TargetHeatingCoolingState.OFF;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => {
                const isOn = this.currentState.targetTempL > MIN_TEMP;
                return isOn
                    ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                    : this.Characteristic.CurrentHeatingCoolingState.OFF;
            });

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHoursL * BRIGHTNESS_PER_HOUR);

        this.timerService.setCharacteristic(this.Characteristic.Brightness, this.currentState.timerHoursL * BRIGHTNESS_PER_HOUR);
        this.timerService.setCharacteristic(this.Characteristic.On, this.currentState.timerOn);
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] 전원 OFF 명령 수신. 왼쪽 영역 Level 0 (OFF)으로 설정합니다.');
            await this.sendTempCommand(MIN_TEMP);
        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도 (${this.currentState.lastHeatTemp}°C)로 복원합니다.`);
            await this.sendTempCommand(this.currentState.lastHeatTemp);
        }
    }

    async handleSetTargetTemperature(value) {
        await this.sendTempCommand(value);
    }

    async sendTempCommand(tempL) {
        const levelL = TEMP_LEVEL_MAP[Math.round(tempL / 5) * 5] || 0;
        const levelR = 0;
        const actualTempL = LEVEL_TEMP_MAP[levelL];
        const actualTempR = MIN_TEMP;
        const packet = this.createTempPacket(levelL, levelR);
        const packetHex = packet.toString('hex');

        if (!this.tempCharacteristic || !this.isConnected) {
            this.log.warn('[온도] BLE 연결이 끊겼습니다. 명령 실패. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        for (let attempt = 1; attempt <= MAX_RETRY_COUNT; attempt++) {
            try {
                this.log.info(`[온도] 시도 ${attempt}/${MAX_RETRY_COUNT}: 왼쪽: ${actualTempL}°C (Level ${levelL}) 설정. 패킷: ${packetHex}`);

                await sleep(100);
                await this.tempCharacteristic.writeValue(packet);

                this.log.info(`[온도] ${attempt}번의 시도 끝에 쓰기 성공.`);

                this.currentState.targetTempL = actualTempL;
                this.currentState.targetTempR = actualTempR;
                this.currentState.currentTempL = actualTempL;
                this.currentState.currentTempR = actualTempR;

                const isOn = actualTempL > MIN_TEMP;
                this.currentState.currentHeatingCoolingState =
                    isOn ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (isOn) {
                    this.currentState.lastHeatTemp = actualTempL;
                }

                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, actualTempL);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, actualTempL);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, isOn
                    ? this.Characteristic.TargetHeatingCoolingState.HEAT
                    : this.Characteristic.TargetHeatingCoolingState.OFF);

                return;

            } catch (error) {
                this.log.warn(`[온도] 시도 ${attempt} 실패: ${error.message}. ${RETRY_DELAY_MS}ms 후 재시도...`);
                await sleep(RETRY_DELAY_MS);
            }
        }

        this.log.error(`[온도] ${MAX_RETRY_COUNT}번의 시도 후에도 패킷 쓰기 실패 (${packetHex}). 연결을 끊습니다.`);
        this.disconnectDevice();
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }


    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) { hours = 1; }
        if (hours > MAX_TIMER_HOURS) { hours = MAX_TIMER_HOURS; }

        await this.sendTimerCommand(hours);

        this.currentState.timerHoursL = hours;
        this.currentState.timerHoursR = 0;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
        this.log.info(`[타이머] 밝기 ${value}% 수신 -> ${hours} 시간 설정됨. (HomeKit: ${brightnessToSet}%)`);
    }

    async handleTimerSwitch(value) {
        let hoursToSend = 0;
        let brightnessToSet = 0;

        if (value === false) {
            this.log.info('[타이머] HomeKit 스위치 OFF. 타이머 비활성화 (0 시간).');
        } else {
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                this.log.info('[타이머] HomeKit 스위치 ON. 타이머가 0이므로 기본 1시간으로 설정.');
            }
            brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
            this.log.info(`[타이머] HomeKit 스위치 ON. ${hoursToSend} 시간으로 복원합니다.`);
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHoursL = hoursToSend;
        this.currentState.timerHoursR = 0;
        this.currentState.timerOn = value;

        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hoursL) {
        const hoursR = 0;
        const packet = this.createTimerPacket(hoursL, hoursR);
        const packetHex = packet.toString('hex');

        if (!this.timeCharacteristic || !this.isConnected) {
            this.log.warn('[타이머] BLE 연결이 끊겼습니다. 명령 실패. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        for (let attempt = 1; attempt <= MAX_RETRY_COUNT; attempt++) {
            try {
                this.log.info(`[타이머] 시도 ${attempt}/${MAX_RETRY_COUNT}: 왼쪽: ${hoursL} 시간 명령 전송. 패킷: ${packetHex}`);

                await sleep(100);
                await this.timeCharacteristic.writeValue(packet);

                this.log.info(`[타이머] ${attempt}번의 시도 끝에 쓰기 성공.`);
                return;
            } catch (error) {
                this.log.warn(`[타이머] 시도 ${attempt} 실패: ${error.message}. ${RETRY_DELAY_MS}ms 후 재시도...`);
                await sleep(RETRY_DELAY_MS);
            }
        }

        this.log.error(`[타이머] ${MAX_RETRY_COUNT}번의 시도 후에도 패킷 쓰기 실패 (${packetHex}). 연결을 끊습니다.`);
        this.disconnectDevice();
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }


    initNodeBle() {
        this.initializeBleAdapter();
    }

    async initializeBleAdapter() {
        try {
            this.log.info('[BLE] node-ble을 사용하여 BLE 초기화를 시도합니다.');

            const { bluetooth } = NodeBle.createBluetooth();

            let adapter;
            if (this.adapterId && this.adapterId !== 'hci0') {
                adapter = await bluetooth.getAdapter(this.adapterId);
            } else {
                adapter = await bluetooth.defaultAdapter();
            }

            this.adapter = adapter;
            this.log.info(`[BLE] 어댑터 (${this.adapterId}) 초기화 성공. 스캔 루프를 시작합니다.`);
            this.startScanningLoop();
        } catch (error) {
            this.log.error(`[BLE] node-ble 초기화 실패. BlueZ 서비스 및 권한을 확인하십시오: ${error.message}`);
        }
    }

    async startScanningLoop() {
        if (!this.adapter || this.isScanningLoopActive) {
            this.log.debug('[BLE] 스캔 루프 조건 미충족 (어댑터 없음 또는 이미 실행 중).');
            return;
        }

        this.isScanningLoopActive = true;
        this.log.info('[BLE] 백그라운드 스캔/재연결 루프를 시작합니다.');

        while (this.isScanningLoopActive) {
            if (!this.isConnected) {
                this.log.info('[BLE] 연결되지 않음. 스캔을 시작합니다...');

                try {
                    // 🚨 안전 장치: 스캔 시작 전에 이전 검색을 중지합니다.
                    try {
                        await this.adapter.stopDiscovery();
                    } catch (e) {
                        this.log.debug(`[BLE] 기존 Discovery 중지 실패 (정상일 수 있음): ${e.message}`);
                    }

                    await this.adapter.startDiscovery();

                    const targetAddress = this.macAddress.toUpperCase();

                    await sleep(SCAN_DURATION_MS);

                    // 스캔 종료
                    await this.adapter.stopDiscovery();

                    const deviceAddresses = await this.adapter.devices();

                    let targetDevice = null;
                    let foundAddress = null;
                    let deviceName = 'Unknown';

                    for (const address of deviceAddresses) {
                        const normalizedAddress = address.toUpperCase().replace(/:/g, '');

                        if (normalizedAddress === targetAddress) {
                            targetDevice = await this.adapter.getDevice(address);
                            foundAddress = address;

                            try {
                                deviceName = await targetDevice.getName();
                            } catch (e) {
                                this.log.debug(`이름을 가져올 수 없습니다. ${foundAddress}: ${e.message}`);
                            }
                            break;
                        }
                    }

                    if (targetDevice) {
                        this.device = targetDevice;
                        this.log.info(`[BLE] 매트 장치 발견: ${deviceName} (${foundAddress})`);
                        await this.connectDevice();
                    } else {
                        if (deviceAddresses.length > 0) {
                            this.log.info(`[BLE] 대상 장치 (${targetAddress})를 찾을 수 없습니다. 주변 장치 수: ${deviceAddresses.length}`);
                        } else {
                            this.log.info(`[BLE] 대상 장치 (${targetAddress})를 찾을 수 없습니다. 주변에 장치가 없습니다.`);
                        }
                    }

                } catch (error) {
                    this.log.error(`[BLE] 스캔 오류 발생: ${error.message}`);
                }
            } else {
                this.log.debug('[BLE] 연결이 유지되고 있습니다. 다음 스캔 주기까지 대기.');
            }

            await sleep(this.scanInterval);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected) {
            return;
        }

        try {
            this.log.info(`[BLE] 매트에 연결을 시도합니다 (Timeout: ${CONNECT_TIMEOUT_MS}ms)...`);
            // 🚨 핵심 변경: 명시적인 연결 타임아웃 추가
            await this.device.connect({ timeout: CONNECT_TIMEOUT_MS });
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            // 연결 후 장치 안정화 시간 확보
            await sleep(INITIAL_CONNECT_DELAY_MS);

            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 매트 연결이 끊어졌습니다. 재연결 루프를 재시작합니다.`);
                this.disconnectDevice();
            });

            await this.discoverCharacteristics();

            await this.enableNotificationsAndInit();

        } catch (error) {
            this.log.error(`[BLE] 매트 연결 실패: ${error.message}. 장치 정보를 초기화하고 스캔 루프를 재시작합니다.`);
            // 실패 시 장치 객체를 null로 초기화하여 다음 스캔에서 새로 찾도록 강제
            this.disconnectDevice(true);
        }
    }

    async discoverCharacteristics() {
        if (!this.isConnected || !this.device) return;

        try {
            this.log.info(`[BLE] 대상 서비스 검색 중: ${this.serviceUuid}`);

            const gatt = await this.device.gatt();

            const service = await gatt.getPrimaryService(this.serviceUuid);
            this.log.info(`[BLE] 서비스 ${this.serviceUuid}를 성공적으로 찾았습니다.`);

            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);

            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 Characteristic을 찾았습니다. 제어 준비 완료.');
            } else {
                this.log.error(`[BLE] 하나 이상의 필수 Characteristic을 찾을 수 없습니다. (온도: ${!!this.tempCharacteristic}, 타이머: ${!!this.timeCharacteristic}). 연결을 끊습니다.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] Characteristic 검색 오류: ${error.message}.`);
            this.log.error('[BLE] config.json의 서비스 및 Characteristic UUID가 정확한지 확인하십시오.');
            this.disconnectDevice(true);
        }
    }

    async enableNotificationsAndInit() {
        if (!this.isConnected || !this.tempCharacteristic || !this.timeCharacteristic) {
            this.log.warn('[초기화] 연결 또는 Characteristic이 준비되지 않았습니다.');
            return;
        }

        try {
            this.log.info('[초기화] FF20 및 FF30에 대한 알림(Indication) 활성화 중...');

            this.log.info('[초기화] 1. FF20 (온도) 알림 활성화.');
            await this.tempCharacteristic.startNotifications();
            this.tempCharacteristic.on('valuechanged', this.handleCharacteristicUpdate.bind(this));
            this.log.info('[초기화] FF20 알림 활성화됨.');

            this.log.info('[초기화] 2. FF30 (타이머) 알림 활성화.');
            await this.timeCharacteristic.startNotifications();
            this.timeCharacteristic.on('valuechanged', this.handleCharacteristicUpdate.bind(this));
            this.log.info('[초기화] FF30 알림 활성화됨.');

            this.log.info('[초기화] 3. 초기 상태 요청 패킷 전송.');
            await this.sendInitCommandWithRetry();

        } catch (error) {
            this.log.error(`[초기화] 알림 설정 또는 초기화 쓰기 실패: ${error.message}`);
            this.disconnectDevice();
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async sendInitCommandWithRetry() {
        const initPacket = Buffer.from([0x01]);
        const packetHex = initPacket.toString('hex');

        for (let attempt = 1; attempt <= MAX_RETRY_COUNT; attempt++) {
            try {
                this.log.info(`[초기화] 시도 ${attempt}/${MAX_RETRY_COUNT}: FF20으로 초기화 패킷 전송: ${packetHex}`);

                await sleep(500);
                await this.tempCharacteristic.writeValue(initPacket);

                this.log.info('[초기화] 초기화 명령이 FF20을 통해 성공적으로 전송되었습니다.');
                return;
            } catch (error) {
                this.log.warn(`[초기화] 시도 ${attempt} 실패: ${error.message}. ${RETRY_DELAY_MS}ms 후 재시도...`);
                await sleep(RETRY_DELAY_MS);
            }
        }

        this.log.error(`[초기화] ${MAX_RETRY_COUNT}번의 시도 후에도 초기화 패킷 쓰기 실패 (${packetHex}). 연결을 끊습니다.`);
        this.disconnectDevice();
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    handleCharacteristicUpdate(data) {
        this.log.info(`[수신] 데이터 수신: ${data.toString('hex')}`);
        // 현재는 상태 업데이트가 없으므로 데이터를 로깅만 합니다.
    }

    disconnectDevice(resetDevice = false) {
        const deviceToDisconnect = this.device;
        this.isConnected = false;

        if (this.tempCharacteristic) {
            this.tempCharacteristic.stopNotifications().catch(e => this.log.warn(`[BLE] FF20 알림 중지 실패: ${e.message}`));
        }
        if (this.timeCharacteristic) {
            this.timeCharacteristic.stopNotifications().catch(e => this.log.warn(`[BLE] FF30 알림 중지 실패: ${e.message}`));
        }

        this.tempCharacteristic = null;
        this.timeCharacteristic = null;

        if (resetDevice) {
            this.log.warn('[BLE] 장치 캐시 초기화. 다음 스캔에서 장치를 새로 찾습니다.');
            this.device = null; // 장치 객체 자체를 초기화
        }

        if (deviceToDisconnect) {
            deviceToDisconnect.isConnected().then(connected => {
                if(connected) {
                    deviceToDisconnect.disconnect().catch(e => this.log.warn(`[BLE] 안전한 연결 해제 실패: ${e.message}`));
                }
            }).catch(e => this.log.warn(`[BLE] 연결 상태 확인 중 오류 발생 (무시됨): ${e.message}`));
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
