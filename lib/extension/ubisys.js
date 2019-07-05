const Enum = require('enum');
const zclId = require('zcl-id');
const settings = require('../util/settings');
const logger = require('../util/logger');
const Q = require('q');

const topicRegex = new RegExp(`^${settings.get().mqtt.base_topic}/ubisys/.+/(read_input_configuration|configure_inputs|read_config_attributes_j1|configure_j1)$`);
const topicSpecificDeviceRegex = new RegExp('_(c4|d1|j1|s1)$');

const ubisysManufCode = 0x10f2;
const ubisysDevMgmtEndpoint = 232;
const _ubisysConfigurationClusters = {
    closuresWindowCovering: {
        id: zclId.clusterId.get('closuresWindowCovering').value,
        attributes: {
            windowCoveringType: { id: 0x0000, type: 'enum8', manufCode: ubisysManufCode },
            configStatus: { id: 0x0007, type: 'bitmap8', manufCode: ubisysManufCode },
            installedOpenLimitLiftCm: { id: 0x0010, type: 'uint16', manufCode: ubisysManufCode },
            installedClosedLimitLiftCm: { id: 0x0011, type: 'uint16', manufCode: ubisysManufCode },
            installedOpenLimitTiltDdegree: { id: 0x0012, type: 'uint16', manufCode: ubisysManufCode },
            installedClosedLimitTiltDdegree: { id: 0x0013, type: 'uint16', manufCode: ubisysManufCode },
            turnaroundGuardTime: { id: 0x1000, type: 'uint8', manufCode: ubisysManufCode },
            liftToTiltTransitionSteps: { id: 0x1001, type: 'uint16', manufCode: ubisysManufCode },
            totalSteps: { id: 0x1002, type: 'uint16', manufCode: ubisysManufCode },
            liftToTiltTransitionSteps2: { id: 0x1003, type: 'uint16', manufCode: ubisysManufCode },
            totalSteps2: { id: 0x1004, type: 'uint16', manufCode: ubisysManufCode },
            additionalSteps: { id: 0x1005, type: 'uint8', manufCode: ubisysManufCode },
            inactivePowerThreshold: { id: 0x1006, type: 'uint16', manufCode: ubisysManufCode },
            startupSteps: { id: 0x1007, type: 'uint16', manufCode: ubisysManufCode },
        },
    },
    manuSpecificUbisysDeviceSetup: {
        id: 0xfc00,
        attributes: {
            inputConfigurations: { id: 0x0000, type: 'array' },
            inputActions: { id: 0x0001, type: 'array' },
        },
    },
};

const cfgClusters = new Enum(Object.entries(_ubisysConfigurationClusters).reduce((accumulator, current) => {
    accumulator[current[0]] = current[1].id;
    return accumulator;
}, {}));

const cfgClusterAttrs = {};
Object.entries(_ubisysConfigurationClusters).forEach((cluster) => {
    let attrList = zclId.attrList(cluster[0]) || [];
    attrList.forEach((attr) => {
        attr.key = zclId.attr(cluster[0], attr.attrId).key;
    });
    attrList = attrList.concat(Object.entries(cluster[1].attributes).map(attr => ({
        key: attr[0],
        attrId: attr[1].id,
        dataType: zclId.dataType(attr[1].type).value,
        manufCode: attr[1].manufCode
    })));

    cfgClusterAttrs[cluster[0]] = {
        attrIds: new Enum(attrList.reduce((acc, current) => { acc[current.key] = current.attrId; return acc; }, {})),
        attrSpecs: new Enum(attrList.reduce((acc, current) => { acc[current.key] = { type: current.dataType, manufCode: current.manufCode }; return acc; }, {})),
    };
});


class Ubisys {
    constructor(zigbee, mqtt, state, publishEntityState) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
    }

    onMQTTConnected() {
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/ubisys/+/read_input_configuration`);
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/ubisys/+/configure_inputs`);
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/ubisys/+/read_config_attributes_j1`);
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

        return { friendlyName: topic, type };
    }

    onMQTTMessage(topic, message) {
        topic = this.parseTopic(topic);
        if (!topic) {
            return false;
        }
        const log = `ubisys ${topic.type} for entity '${topic.friendlyName}'`;
        logger.info(`${log} starting`);

        // Resolve and check the entity
        const entity = settings.resolveEntity(topic.friendlyName);
        const device = entity ? this.zigbee.getDevice(entity.ID) : null;
        if (!entity || entity.type !== 'device' || !device) {
            logger.error(`${log} - Failed to find device with ieeeAddr '${entity.ID}'`);
            return;
        }
        if (device.manufName !== 'ubisys') {
            logger.error(`${log} - Not an ubisys device: '${device.manufName}'`);
            return;
        }
        if (topic.type.match(topicSpecificDeviceRegex)) {
            const modelPrefix = topic.type.substr(-2).toUpperCase();
            if (!device.modelId.startsWith(modelPrefix)) {
                logger.error(`${log} - Only works on ubisys ${modelPrefix} or ${modelPrefix}-R: '${device.modelId}'`);
                return;
            }
        }

        // calls with no (json) input
        switch (topic.type) {

            case 'read_input_configuration':
                this.readInputConfiguration(topic, log, entity);
                return true;

            case 'read_config_attributes_j1':
                this.readConfigAttributesJ1(topic, log, entity);
                return true;
        }


        // the following calls need JSON input
        let json = {};
        try {
            json = JSON.parse(message);
        } catch (e) {
            logger.error(`Unable to parse JSON message: '${message}'`);
            return;
        }

        switch (topic.type) {

            case 'configure_inputs':

                /*
                MQTT-Topic: zigbee2mqtt/ubisys/<friendly_name>/configure_inputs
                
                Examples
                {
                    "inputActions": {
                        "elmType": 65,
                        "elmVals": [
                            [ 0, 13, 2, 2, 1, 0 ],
                            [ 0, 7, 2, 2, 1, 2 ],
                            [ 1, 13, 2, 2, 1, 1 ],
                            [ 1, 7, 2, 2, 1, 2 ]
                        ]
                    }
                }
                {
                    "inputActions": {
                        "elmType": 65,
                        "elmVals": [
                            "000D02020100",
                            "000702020102",
                            "010D02020101",
                            "010702020102"
                        ]
                    }
                }
                {
                    "inputConfigurations": {
                        "elmType": 8,
                        "elmVals": [ 0, 0 ]
                    }
                }
                */

                // TBD It does seem to work now with the fixes in zcl-packet, but it definitely needs more testing...
                var options = { log, 'entity': entity, ep: ubisysDevMgmtEndpoint, cluster: 'manuSpecificUbisysDeviceSetup', 'json': json, steps: [] };
                this.writeAttrFromJson(options, 'inputConfigurations');
                this.writeAttrFromJson(options, 'inputActions');
                options.steps.reduce(Q.when, Q(0)).done((value) => {
                    logger.warn(`${log}: completed, will now read back the results.`);
                    this.readInputConfiguration(topic, log, entity);
                }, (reason) => {
                    logger.error(`${log} failed: ${reason}`);
                });

                return true;

            case 'configure_j1':
                /*
                MQTT-Topic: zigbee2mqtt/ubisys/<friendly_name>/configure_j1
                
                Calibration Example
                {
                    "windowCoveringType": 8,
                    "calibrate" : {
                        "delay_first_open": 10,
                        "delay_close_open": 45
                    },
                    "lift_to_tilt_transition_ms": 1600
                }
                */

                var options = { log, 'entity': entity, cluster: 'closuresWindowCovering', 'json': json, steps: [] };
                var hasCalibrate = json.hasOwnProperty('calibrate');
                var delayCloseOpen, delayFirstOpen;
                var stepsPerSecond = json.steps_per_second || 50;

                if (hasCalibrate) {
                    logger.warn(`${log}: starting calibration run...`);

                    delayCloseOpen = json.calibrate.delay_close_open ? json.calibrate.delay_close_open : 60;
                    delayFirstOpen = json.calibrate.delay_first_open ? json.calibrate.delay_first_open : delayCloseOpen;

                    // first of all, move to top position to not confuse calibration later
                    this.zclCommand(options, 'upOpen');
                    this.delay(options, delayFirstOpen);
                    // cancel any running calibration
                    this.writeAttr(options, 'windowCoveringMode', 0);
                    this.delay(options, 2);
                }

                if (this.writeAttrFromJson(options, 'windowCoveringType')) {
                    this.delay(options, 5);
                }

                if (hasCalibrate) {
                    // reset attributes
                    this.writeAttr(options, 'installedOpenLimitLiftCm', 0);
                    this.writeAttr(options, 'installedClosedLimitLiftCm', 240);
                    this.writeAttr(options, 'installedOpenLimitTiltDdegree', 0);
                    this.writeAttr(options, 'installedClosedLimitTiltDdegree', 900);
                    this.writeAttr(options, 'liftToTiltTransitionSteps', 0xffff);
                    this.writeAttr(options, 'totalSteps', 0xffff);
                    this.writeAttr(options, 'liftToTiltTransitionSteps2', 0xffff);
                    this.writeAttr(options, 'totalSteps2', 0xffff);
                    // enable calibration mode
                    this.delay(options, 2);
                    this.writeAttr(options, 'windowCoveringMode', 0x02);
                    this.delay(options, 2);
                    // move down a bit and back up to detect upper limit
                    this.zclCommand(options, 'downClose');
                    this.delay(options, 5);
                    this.zclCommand(options, 'stop');
                    this.delay(options, 2);
                    this.zclCommand(options, 'upOpen');
                    this.delay(options, 10);
                    // move down to count steps
                    this.zclCommand(options, 'downClose');
                    this.delay(options, delayCloseOpen);
                    // move up to count steps in the other direction
                    this.zclCommand(options, 'upOpen');
                    this.delay(options, delayCloseOpen);
                }

                // now write any attribute values present in JSON
                this.writeAttrFromJson(options, 'configStatus');
                this.writeAttrFromJson(options, 'installedOpenLimitLiftCm');
                this.writeAttrFromJson(options, 'installedClosedLimitLiftCm');
                this.writeAttrFromJson(options, 'installedOpenLimitTiltDdegree');
                this.writeAttrFromJson(options, 'installedClosedLimitTiltDdegree');
                this.writeAttrFromJson(options, 'turnaroundGuardTime');
                this.writeAttrFromJson(options, 'liftToTiltTransitionSteps');
                this.writeAttrFromJson(options, 'totalSteps');
                this.writeAttrFromJson(options, 'liftToTiltTransitionSteps2');
                this.writeAttrFromJson(options, 'totalSteps2');
                this.writeAttrFromJson(options, 'additionalSteps');
                this.writeAttrFromJson(options, 'inactivePowerThreshold');
                this.writeAttrFromJson(options, 'startupSteps');
                // some convenience functions to not have to calculate
                this.writeAttrFromJson(options, 'totalSteps', 'open_to_closed_s', (s) => { s * stepsPerSecond });
                this.writeAttrFromJson(options, 'totalSteps2', 'closed_to_open_s', (s) => { s * stepsPerSecond });
                this.writeAttrFromJson(options, 'liftToTiltTransitionSteps', 'lift_to_tilt_transition_ms', (s) => s * stepsPerSecond / 1000);
                this.writeAttrFromJson(options, 'liftToTiltTransitionSteps2', 'lift_to_tilt_transition_ms', (s) => s * stepsPerSecond / 1000);

                if (hasCalibrate) {
                    // disable calibration mode again
                    this.delay(options, 2);
                    this.writeAttr(options, 'windowCoveringMode', 0x00);
                    this.delay(options, 2);
                }

                // just in case this also is present in JSON
                this.writeAttrFromJson(options, 'windowCoveringMode');

                // run all steps
                options.steps.reduce(Q.when, Q(0)).done((value) => {
                    if (hasCalibrate) {
                        logger.warn(`${log}: calibration run completed, will now read back the results.`);
                        this.readConfigAttributesJ1(topic, log, entity);
                    }
                    else {
                        logger.info(`${log} finished.`);
                    }
                }, (reason) => {
                    logger.error(`${log} failed: ${reason}`);
                });

                return true;
        }
    }

    readInputConfiguration(topic, log, entity) {
        var options = { log, 'entity': entity, ep: ubisysDevMgmtEndpoint, cluster: 'manuSpecificUbisysDeviceSetup', steps: [], result: {} };
        this.readAttr(options, 'inputConfigurations');
        this.readAttr(options, 'inputActions');
        options.steps.reduce(Q.when, Q(0)).done((value) => {
            logger.info(`${log} result:\n${JSON.stringify(options.result, null, 2)}`);
            this.mqtt.log(`ubisys_${topic.friendlyName}`, { input_configuration: options.result });
        }, (reason) => {
            logger.error(`${log} failed: ${reason}`);
        });

    }

    readConfigAttributesJ1(topic, log, entity) {
        var options = { log, 'entity': entity, cluster: 'closuresWindowCovering', steps: [], result: {} };
        this.readAttr(options, 'windowCoveringType');
        this.readAttr(options, 'physicalClosedLimitLiftCm');
        this.readAttr(options, 'physicalClosedLimitTiltDdegree');
        this.readAttr(options, 'currentPositionLiftCm');
        this.readAttr(options, 'currentPositionTiltDdegree');
        this.readAttr(options, 'configStatus');
        this.readAttr(options, 'currentPositionLiftPercentage');
        this.readAttr(options, 'currentPositionTiltPercentage');
        this.readAttr(options, 'operationalStatus');
        this.readAttr(options, 'installedOpenLimitLiftCm');
        this.readAttr(options, 'installedClosedLimitLiftCm');
        this.readAttr(options, 'installedOpenLimitTiltDdegree');
        this.readAttr(options, 'installedClosedLimitTiltDdegree');
        this.readAttr(options, 'windowCoveringMode');
        this.readAttr(options, 'turnaroundGuardTime');
        this.readAttr(options, 'liftToTiltTransitionSteps');
        this.readAttr(options, 'totalSteps');
        this.readAttr(options, 'liftToTiltTransitionSteps2');
        this.readAttr(options, 'totalSteps2');
        this.readAttr(options, 'additionalSteps');
        this.readAttr(options, 'inactivePowerThreshold');
        this.readAttr(options, 'startupSteps');
        options.steps.reduce(Q.when, Q(0)).done((value) => {
            logger.info(`${log} result:\n${JSON.stringify(options.result, null, 2)}`);
            this.mqtt.log(`ubisys_${topic.friendlyName}`, { config_attributes: options.result });
        }, (reason) => {
            logger.error(`${log} failed: ${reason}`);
        });
    }

    delay(options, seconds) {
        var result = () => {
            return Q(0)
                .then(() => { logger.warn(`${options.log}: waiting for ${seconds} seconds...`); })
                .then(() => { return Q.delay(seconds * 1000); });
        };
        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }

    readAttr(options, attr, cluster, ep) {

        cluster = cluster || options.cluster;
        ep = ep || options.ep;
        const cid = cfgClusters.get(cluster).value,
            attrId = cfgClusterAttrs[cluster].attrIds.get(attr).value,
            attrSpecs = cfgClusterAttrs[cluster].attrSpecs.get(attr).value;

        var self = this;
        var result = function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                options.entity.ID,
                options.entity.type,
                cid,
                'read',
                'foundation',
                [{ attrId: attrId }],
                (attrSpecs.manufCode ? { manufSpec: 1, manufCode: attrSpecs.manufCode } : {}),
                ep
            )
                .then((rsp) => {
                    logger.debug(`ubisys readAttr received response ${JSON.stringify(rsp)}`);
                    var rec = rsp[0];
                    if ((rsp.statusCode && rsp.statusCode !== 0) || rec.status !== 0) {
                        throw `ubisys readAttr unsuccess: ${rsp.statusCode || rec.status}`;
                    }
                    if (options.result) {
                        if (!options.result[cluster])
                            options.result[cluster] = {};
                        options.result[cluster][attr] = rec.attrData;
                    }
                    return rec;
                })
        };

        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }

    writeAttr(options, attr, attrData, cluster, ep) {

        cluster = cluster || options.cluster;
        ep = ep || options.ep;
        const cid = cfgClusters.get(cluster).value,
            attrId = cfgClusterAttrs[cluster].attrIds.get(attr).value,
            attrSpecs = cfgClusterAttrs[cluster].attrSpecs.get(attr).value;

        var self = this;
        var result = function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                options.entity.ID,
                options.entity.type,
                cid,
                'write',
                'foundation',
                [{ attrId: attrId, dataType: attrSpecs.type, attrData: attrData, }],
                (attrSpecs.manufCode ? { manufSpec: 1, manufCode: attrSpecs.manufCode } : {}),
                ep
            )
                .then((rsp) => {
                    logger.debug(`ubisys writeAttr received response ${JSON.stringify(rsp)}`);
                    var rec = rsp[0];
                    if ((rsp.statusCode && rsp.statusCode !== 0) || rec.status !== 0) {
                        throw `ubisys writeAttr unsuccess: ${rsp.statusCode || rec.status}`;
                    }
                })
                .delay(200);
        };

        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }


    writeAttrFromJson(options, attr, jsonAttr = attr, converterFunc, cluster, ep) {
        if (options.json.hasOwnProperty(jsonAttr)) {
            var attrValue = options.json[jsonAttr];
            if (converterFunc) {
                attrValue = converterFunc(attrValue);
            }
            return this.writeAttr(options, attr, attrValue);
        }
    }

    zclCommand(options, cmd, cluster, ep) {

        cluster = cluster || options.cluster;
        ep = ep || options.ep;

        var self = this;
        var result = function () {
            return Q.nbind(self.zigbee.publish, self.zigbee)(
                options.entity.ID,
                options.entity.type,
                cluster,
                cmd,
                'functional',
                {},
                {},
                ep
            ).delay(200);
        };

        if (options.steps) {
            options.steps.push(result);
        }
        return result;
    }

    decodeHexStringToByteArray(hexString) {
        var result = [];
        while (hexString.length >= 2) {
            result.push(parseInt(hexString.substring(0, 2), 16));
            hexString = hexString.substring(2, hexString.length);
        }
        return result;
    }
}

module.exports = Ubisys;
