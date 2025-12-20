const { promisify } = require('util');
const sleep = promisify(setTimeout);

function createControlPacket(value) {
    const dataByte = value;
    const checkSum = (0xFF - dataByte) & 0xFF;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(dataByte, 0);
    buffer.writeUInt8(checkSum, 1);
    buffer.writeUInt8(dataByte, 2);
    buffer.writeUInt8(checkSum, 3);
    return buffer;
}

/*function parsePacket(buffer) {
    if (buffer.length < 4) return 0;
    const dataByte = buffer.readUInt8(0);
    const checkSum = buffer.readUInt8(1);
    if (checkSum !== (0xFF - dataByte) & 0xFF) {
        return 0; // 오류
    }
    return dataByte;
}*/

function parsePacket(buffer) {
    if (!buffer || buffer.length < 1) return 0;

    const hex = buffer.toString('hex');

    if (buffer.length >= 2 && buffer.readUInt8(0) >= 250) {
        return buffer.readUInt8(1); // 두 번째 바이트 시도
    }

    return buffer.readUInt8(0);
}

module.exports = {
    sleep,
    createControlPacket,
    parsePacket,
};