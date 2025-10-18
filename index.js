const { Ble } = require('node-ble');
const util = require('util');

const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 50: 7 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

const MAX_TIMER_HOURS = 10;
const BRIGHTNESS_PER_HOUR = 10;

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

    createControlPacket(value) {
        const level = value;
        const checkByte = 0xFF - (level & 0xFF);

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(level, 0);
        buffer.writeUInt8(checkByte, 1);
        buffer.writeUInt8(0x00, 2);
        buffer.writeUInt8(0x00, 3);

        return buffer;
    }

    createAuthPacket() {
        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(0x01, 0);
        buffer.writeUInt8(0xFE, 1);
        buffer.writeUInt8(0x01, 2);
        buffer.writeUInt8(0xFE, 3);
        return buffer;
    }


    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
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
        this.log.info(`[Temp] HomeKit ${value}°C 설정 -> Level ${level}. 패킷: ${packet.toString('hex')}`);


        if (this.tempCharacteristic && this.isConnected) {
            try {
                await this.tempCharacteristic.write(packet, false);

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
                this.disconnectDevice();
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Temp] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

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
                this.log.info('[Timer] HomeKit 스위치 ON. 시간이 0이므로 1시간(10%)으로 설정합니다.');
            }
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHours = hoursToSend;
        this.currentState.timerOn = hoursToSend > 0;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hours) {
        if (hours < 0 || hours > MAX_TIMER_HOURS) {
            this.log.error(`[Timer] 잘못된 타이머 시간 값: ${hours} (0-${MAX_TIMER_HOURS} 사이여야 합니다).`);
            return;
        }

        const packet = this.createControlPacket(hours);
        this.log.info(`[Timer] ${hours} 시간 설정 -> 패킷: ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                await this.timeCharacteristic.write(packet, false);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 오류: ${error.message}`);
                this.disconnectDevice();
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    initNodeBle() {
        if (this.isScanningLoopActive) return;
        this.isScanningLoopActive = true;

        const { createBluetooth } = new Ble(this.adapterId);
        const bluetooth = createBluetooth();
        this.adapter = bluetooth.adapters[0];

        this.scanAndConnect();
    }

    async scanAndConnect() {
        if (this.isConnected) return;

        this.log.info(`[BLE] 장치 스캔 시작: MAC ${this.macAddress}`);

        try {
            const device = await this.adapter.waitDevice(this.macAddress, this.scanInterval / 1000);
            this.device = device;
            await this.connectDevice();
        } catch (error) {
            this.log.warn(`[BLE] 장치 검색/연결 실패: ${error.message}. ${this.scanInterval / 1000}초 후 재시도...`);
            setTimeout(() => this.scanAndConnect(), this.scanInterval);
        }
    }

    async connectDevice() {
        try {
            await this.device.connect();
            this.log.info('[BLE] 장치 연결 성공.');
            this.isConnected = true;

            this.device.on('disconnect', () => {
                this.log.warn('[BLE] 장치 연결이 해제되었습니다. 5초 후 재연결 시도...');
                this.isConnected = false;
                this.tempCharacteristic = null;
                this.timeCharacteristic = null;
                setTimeout(() => this.scanAndConnect(), 5000);
            });

            await this.getServices();

            await this.tempCharacteristic.write(this.createAuthPacket(), false);
            this.log.info('[BLE] 인증 패킷 전송 완료.');

        } catch (error) {
            this.log.error(`[BLE] 연결 중 오류 발생: ${error.message}`);
            this.disconnectDevice();
            setTimeout(() => this.scanAndConnect(), 5000);
        }
    }

    async disconnectDevice() {
        if (this.device) {
            try {
                await this.device.disconnect();
                this.log.info('[BLE] 장치 연결 해제 완료.');
            } catch (error) {
                this.log.error(`[BLE] 연결 해제 중 오류: ${error.message}`);
            }
        }
        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.device = null;
    }

    async getServices() {
        const service = await this.device.getService(this.serviceUuid);
        this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
        this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);
        this.log.info('[BLE] 서비스 및 특성(Characteristics) 발견 완료.');
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
    api.registerAccessory('HeatingMatAccessory', HeatingMatAccessory);
};
