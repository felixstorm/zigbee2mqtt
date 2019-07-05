const settings = require('../util/settings');
const zclId = require('zcl-id');
const logger = require('../util/logger');
const debug = require('debug')('zigbee2mqtt:ubisys');
const Q = require('q');

const topicRegex = new RegExp(`^${settings.get().mqtt.base_topic}/ubisys/.+/config$`);

const cfg = {
    default: {
        manufSpec: 0,
        disDefaultRsp: 0,
    },
    ubisys: {
        manufSpec: 1,
        manufCode: 0x10f2,
    },
};

class Ubisys {
    constructor(zigbee, mqtt, state, publishEntityState) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
    }

    onMQTTConnected() {
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/ubisys/+/config`);
    }


    parseTopic(topic) {
        if (!topic.match(topicRegex)) {
            return null;
        }

        // Remove base from topic
        topic = topic.replace(`${settings.get().mqtt.base_topic}/ubisys/`, '');

        // Remove command from topic
        topic = topic.replace(`/config`, '');

        return { friendlyName: topic };
    }

    onMQTTMessage(topic, message) {
        topic = this.parseTopic(topic);

        if (!topic) {
            return false;
        }

        // Resolve the entity
        const entity = settings.resolveEntity(topic.friendlyName);
        debug(`Entity: ${JSON.stringify(entity)}`);
        const device = entity ? this.zigbee.getDevice(entity.ID) : null;
        debug(`Device: ${JSON.stringify(device)}`);
        if (!entity || entity.type !== 'device' || !device) {
            logger.error(`Failed to find device with ieeeAddr: '${entity.ID}'`);
            return;
        }
        if (device.manufName !== 'ubisys') {
            logger.error(`Not an ubisys device: '${device.manufName}'`);
            return;
        }

        let json = {};
        try {
            json = JSON.parse(message);
        } catch (e) {
            logger.error(`Unable to parse JSON message: '${message}'`);
            return;
        }
        debug(`Message: ${JSON.stringify(json)}`);


        const key = Object.keys(json)[0];
        switch (key) {
            case 'calibrate_j1':
                if (device.modelId !== 'J1 (5502)') {
                    logger.error(`Only works on J1: '${device.modelId}'`);
                    return;
                }

                /*
                zigbee2mqtt/ubisys/0x001fee000000240d/config
                {
                    "calibrate_j1": 8,
                    "delay_first_open": 10,
                    "delay_close_open": 45,
                    "lift_to_tilt_ms": 1600
                }
                */

                const delayCloseOpen = json.delay_close_open ? json.delay_close_open : 60;
                const delayFirstOpen = json.delay_first_open ? json.delay_first_open : delayCloseOpen;
                const lifToTiltMs = json.lift_to_tilt_ms;

                var steps = [
                    this.writeNamed(entity, 'windowCoveringMode', 0x00),
                    () => { return Q.delay(5000); },

                    this.writeNamed(entity, 'windowCoveringType', json.calibrate_j1, cfg.ubisys),
                    this.writeNamed(entity, 'installedOpenLimitLiftCm', 0, cfg.ubisys),
                    this.writeNamed(entity, 'installedClosedLimitLiftCm', 240, cfg.ubisys),
                    this.writeNamed(entity, 'installedOpenLimitTiltDegree', 0, cfg.ubisys),
                    this.writeNamed(entity, 'installedClosedLimitTiltDegree', 900, cfg.ubisys),
                    this.writeNumeric(entity, 0x1001, 33 /* uint16 */, 0xffff, cfg.ubisys),
                    this.writeNumeric(entity, 0x1002, 33 /* uint16 */, 0xffff, cfg.ubisys),
                    this.writeNumeric(entity, 0x1003, 33 /* uint16 */, 0xffff, cfg.ubisys),
                    this.writeNumeric(entity, 0x1004, 33 /* uint16 */, 0xffff, cfg.ubisys),
                    () => { return Q.delay(1000); },

                    this.writeNamed(entity, 'windowCoveringMode', 0x02),
                    () => { return Q.delay(1000); },
                    this.zclCommand(entity, 'downClose'),
                    () => { return Q.delay(3000); },
                    this.zclCommand(entity, 'upOpen'),
                    () => { return Q.delay(delayFirstOpen * 1000); },
                    this.zclCommand(entity, 'downClose'),
                    () => { return Q.delay(delayCloseOpen * 1000); },
                    this.zclCommand(entity, 'upOpen'),
                    () => { return Q.delay(delayCloseOpen * 1000); },
                ]

                if (lifToTiltMs) {
                    const liftToTiltCycles = lifToTiltMs / 20;
                    steps = steps.concat([
                        this.writeNumeric(entity, 0x1001, 33 /* uint16 */, liftToTiltCycles, cfg.ubisys),
                        this.writeNumeric(entity, 0x1003, 33 /* uint16 */, liftToTiltCycles, cfg.ubisys),
                        () => { return Q.delay(1000); },
                    ]);
                }

                steps = steps.concat([
                    this.readNumeric(entity, 0x1001, cfg.ubisys),
                    this.readNumeric(entity, 0x1002, cfg.ubisys),
                    this.readNumeric(entity, 0x1003, cfg.ubisys),
                    this.readNumeric(entity, 0x1004, cfg.ubisys),

                    () => { return Q.delay(3000); },
                    this.writeNamed(entity, 'windowCoveringMode', 0x00),
                ]);

                steps.reduce(Q.when, Q(0)).fail(console.log).done();

                break;

            default:
                logger.error(`Unknown ubisys config object: '${key}'`);
                return;
        }

        return true;
    }

    readNamed(entity, attrName, cfgRead = cfg.default) {
        return this.readNumeric(
            entity,
            zclId.attr('closuresWindowCovering', attrName).value,
            cfgRead
        );
    }

    readNumeric(entity, attrId, cfgRead = cfg.default) {
        var self = this;
        return function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                entity.ID,
                entity.type,
                'closuresWindowCovering',
                'read',
                'foundation',
                [{ attrId: attrId, }],
                cfgRead,
                null
            ).delay(500);
        };
    }

    writeNamed(entity, attrName, attrData, cfgWrite = cfg.default) {
        return this.writeNumeric(
            entity,
            zclId.attr('closuresWindowCovering', attrName).value,
            zclId.attrType('closuresWindowCovering', attrName).value,
            attrData,
            cfgWrite
        );
    }

    writeNumeric(entity, attrId, attrType, attrData, cfgWrite = cfg.default) {
        var self = this;
        return function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                entity.ID,
                entity.type,
                'closuresWindowCovering',
                'write',
                'foundation',
                [{ attrId: attrId, dataType: attrType, attrData: attrData, }],
                cfgWrite,
                null
            ).delay(500);
        };
    }

    zclCommand(entity, cmd, cfgCmd = cfg.default) {
        var self = this;
        return function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                entity.ID,
                entity.type,
                'closuresWindowCovering',
                cmd,
                'functional',
                {},
                cfgCmd,
                null
            ).delay(500);
        };
    }
}

module.exports = Ubisys;
