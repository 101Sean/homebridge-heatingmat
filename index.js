const HeatingMatAccessory = require('./lib/HeatingMatAccessory');

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'Heating Mat', HeatingMatAccessory);
};