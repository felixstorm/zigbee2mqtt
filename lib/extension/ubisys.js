const settings = require('../util/settings');
const zclId = require('zcl-id');
const logger = require('../util/logger');
const debug = require('debug')('zigbee2mqtt:ubisys');
const Q = require('q');

const topicRegex = new RegExp(`^${settings.get().mqtt.base_topic}/ubisys/.+/(configure_j1)$`);

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
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/ubisys/+/configure_j1`);
    }


    parseTopic(topic) {
        if (!topic.match(topicRegex)) {
            return null;
        }

        // Remove base from topic
        topic = topic.replace(`${settings.get().mqtt.base_topic}/ubisys/`, '');

        // Parse type from topic
        const type = topic.substr(topic.lastIndexOf('/') + 1, topic.length);

        // Remove type from topic
        topic = topic.replace(`/${type}`, '');

        return {friendlyName: topic, type};
    }

    onMQTTMessage(topic, message) {
        topic = this.parseTopic(topic);

        if (!topic) {
            return false;
        }
        debug(`Topic: ${JSON.stringify(topic)}`);

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


        switch (topic.type) {
            case 'configure_j1':
                if (device.modelId !== 'J1 (5502)') {
                    logger.error(`Only works on ubisys J1: '${device.modelId}'`);
                    return;
                }

                /*
                MQTT-Topic
                zigbee2mqtt/ubisys/<friendly_name>/configure_j1
                
                All Options:
                {
                    "mode": 0,
                    "type": 8,
                    "configuration_and_status": 0
                    "installed_open_limit_lift": 0
                    "installed_closed_limit_lift": 0
                    "installed_open_limit_tilt": 0
                    "installed_closed_limit_tilt": 0
                    "turnaround_guard_time": 0
                    "lift_to_tilt_transition_steps": 0
                    "total_steps": 0
                    "lift_to_tilt_transition_steps_2": 0
                    "total_steps_2": 0
                    "additional_steps": 0
                    "inactive_power_threshold": 0
                    "startup_steps": 0
                    "calibrate" : {
                        "delay_first_open": 10,
                        "delay_close_open": 45
                    },
                    "steps_per_second": 50
                    "open_to_closed_s": 0
                    "closed_to_open_s": 0
                    "lift_to_tilt_transition_ms": 1600
                }
                
                Calibration Example
                {
                    "type": 8,
                    "calibrate" : {
                        "delay_first_open": 10,
                        "delay_close_open": 45
                    },
                    "lift_to_tilt_transition_ms": 1600
                }
                */

                var options = { 'json': json, 'entity': entity, cid: 'closuresWindowCovering', 'steps': [] };
                var hasCalibrate = json.hasOwnProperty('calibrate');
                var delayCloseOpen, delayFirstOpen;
                var stepsPerSecond = json.stepsPerSecond || 50;

                if (hasCalibrate) {
                    delayCloseOpen = json.calibrate.delay_close_open ? json.calibrate.delay_close_open : 60;
                    delayFirstOpen = json.calibrate.delay_first_open ? json.calibrate.delay_first_open : delayCloseOpen;

                    // fist of all, move to top position to not confuse the J1 later
                    this.zclCommand(options, 'upOpen'),
                    this.delay(options, delayFirstOpen);

                    json.mode = 0;
                    json.installed_open_limit_lift = 0;
                    json.installed_closed_limit_lift = 240;
                    json.installed_open_limit_tilt = 0;
                    json.installed_closed_limit_tilt = 900;
                    json.lift_to_tilt_transition_steps = 0xffff;
                    json.total_steps = 0xffff;
                    json.lift_to_tilt_transition_steps_2 = 0xffff;
                    json.total_steps_2 = 0xffff;
                }

                if (this.writeAttrFromJson(options, 'mode', 'windowCoveringMode')) {
                    this.delay(options, 2);
                }
                if (this.writeAttrFromJson(options, 'type', 'windowCoveringType', true)) {
                    this.delay(options, 5);
                }
                this.writeAttrFromJson(options, 'configuration_and_status', 'configStatus', true);
                this.writeAttrFromJson(options, 'installed_open_limit_lift', 'installedOpenLimitLiftCm', true);
                this.writeAttrFromJson(options, 'installed_closed_limit_lift', 'installedClosedLimitLiftCm', true);
                this.writeAttrFromJson(options, 'installed_open_limit_tilt', 'installedOpenLimitTiltDdegree', true);
                this.writeAttrFromJson(options, 'installed_closed_limit_tilt', 'installedClosedLimitTiltDdegree', true);
                this.writeAttrFromJson(options, 'turnaround_guard_time', 0x1000, true, 32);             // 'TurnaroundGuardTime', uint8
                this.writeAttrFromJson(options, 'lift_to_tilt_transition_steps', 0x1001, true, 33);     // 'LiftToTiltTransitionSteps', uint16
                this.writeAttrFromJson(options, 'total_steps', 0x1002, true, 33);                       // 'TotalSteps', uint16
                this.writeAttrFromJson(options, 'lift_to_tilt_transition_steps_2', 0x1003, true, 33);   // 'LiftToTiltTransitionSteps2', uint16
                this.writeAttrFromJson(options, 'total_steps_2', 0x1004, true, 33);                     // 'TotalSteps2', uint16
                this.writeAttrFromJson(options, 'additional_steps', 0x1005, true, 32);                  // 'AdditionalSteps', uint8
                this.writeAttrFromJson(options, 'inactive_power_threshold', 0x1006, true, 33);          // 'InactivePowerThreshold', uint16
                this.writeAttrFromJson(options, 'startup_steps', 0x1007, true, 33);                     // 'StartupSteps', uint16

                if (hasCalibrate) {
                    this.delay(options, 2);
                    this.writeAttr(options, 'windowCoveringMode', false, 0, 0x02),
                    this.delay(options, 2);

                    this.zclCommand(options, 'downClose'),
                    this.delay(options, 5);
                    this.zclCommand(options, 'stop'),
                    this.delay(options, 2);
                    this.zclCommand(options, 'upOpen'),
                    this.delay(options, 10);
                    this.zclCommand(options, 'downClose'),
                    this.delay(options, delayCloseOpen);
                    this.zclCommand(options, 'upOpen'),
                    this.delay(options, delayCloseOpen);
                }

                this.writeAttrFromJson(options, 'open_to_closed_s', 0x1002, true, 33, (s) => { s * stepsPerSecond });               // 'TotalSteps', uint16
                this.writeAttrFromJson(options, 'closed_to_open_s', 0x1004, true, 33, (s) => { s * stepsPerSecond });               // 'TotalSteps2', uint16
                this.writeAttrFromJson(options, 'lift_to_tilt_transition_ms', 0x1001, true, 33, (s) => s * stepsPerSecond / 1000);  // 'LiftToTiltTransitionSteps', uint16
                this.writeAttrFromJson(options, 'lift_to_tilt_transition_ms', 0x1003, true, 33, (s) => s * stepsPerSecond / 1000);  // 'LiftToTiltTransitionSteps2', uint16

                if (hasCalibrate) {
                    this.delay(options, 2);
                    this.writeAttr(options, 'windowCoveringMode', false, 0, 0x00),
                    this.delay(options, 2);
                }

                this.delay(options, 1);
                this.readAttr(options, 'windowCoveringType');
                this.readAttr(options, 0x1001, true);
                this.readAttr(options, 0x1002, true);
                this.readAttr(options, 0x1003, true);
                this.readAttr(options, 0x1004, true);

                options.steps.reduce(Q.when, Q(0)).fail(console.log).done();

                break;
        }

        return true;
    }

    delay(options, seconds) {
        var result = () => { return Q.delay(seconds * 1000); };
        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }

    readAttr(options, attr, ubisys) {

        if (!Number.isInteger(attr)) {
            attr = zclId.attr(options.cid, attr).value;
        }

        var self = this;
        var result = function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                options.entity.ID,
                options.entity.type,
                options.cid,
                'read',
                'foundation',
                [{ attrId: attr }],
                ubisys ? cfg.ubisys : cfg.default,
                null
            ).delay(200);
        };

        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }

    writeAttrFromJson(options, jsonName, attr, ubisys, attrType, converterFunc) {
        if (options.json.hasOwnProperty(jsonName)) {
            var attrValue = options.json[jsonName];
            if (converterFunc) {
                attrValue = converterFunc(attrValue);
            }
            return this.writeAttr(options, attr, ubisys, attrType, attrValue);
        }
    }

    writeAttr(options, attr, ubisys, attrType, attrData) {

        if (!Number.isInteger(attr)) {
            attr = zclId.attr(options.cid, attr).value;
            attrType = zclId.attrType(options.cid, attr).value;
        }

        var self = this;
        var result = function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                options.entity.ID,
                options.entity.type,
                options.cid,
                'write',
                'foundation',
                [{ attrId: attr, dataType: attrType, attrData: attrData, }],
                ubisys ? cfg.ubisys : cfg.default,
                null
            ).delay(200);
        };

        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }

    zclCommand(options, cmd, params = {}, ubisys = false) {
        var self = this;
        var result = function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                options.entity.ID,
                options.entity.type,
                options.cid,
                cmd,
                'functional',
                params,
                ubisys ? cfg.ubisys : cfg.default,
                null
            ).delay(200);
        };

        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }
}

module.exports = Ubisys;
