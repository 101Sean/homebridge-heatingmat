const HeatingMatAccessory = require('./lib/HeatingMatAccessory');

class HeatingMatPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;

        if (!this.config || !this.config.devices) return;

        this.api.on('didFinishLaunching', () => {
            this.config.devices.forEach(deviceConfig => {
                const accessory = new HeatingMatAccessory(this.log, deviceConfig, this.api);

                this.api.publishExternalAccessories('homebridge-heatingmat', [{
                    category: this.api.hap.Categories.THERMOSTAT,
                    services: accessory.getServices(),
                    displayName: deviceConfig.name
                }]);
            });
        });
    }
}

module.exports = (api) => {
    api.registerPlatform('homebridge-heatingmat', 'Heating Mat Platform', HeatingMatPlatform);
};