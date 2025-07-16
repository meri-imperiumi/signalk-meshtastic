/* eslint import/no-unresolved: 1 */
const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');

// Hack for Node.js compatibility of Meshtastic Deno lib
const crypto = require('node:crypto');

global.crypto = crypto;

// The ES modules we'll need to import
let MeshDevice;
let TransportHTTP;
let create;
let toBinary;
let Protobuf;

function nodeToSignalK(app, node, nodeInfo) {
  let context;
  if (node.thisNode) {
    context = 'vessels.self';
  }
  // TODO: Create context for other nodes
  // TODO: Associate nodes with AIS vessels if callsign available
  if (!context) {
    return;
  }
  const values = [
    {
      path: 'communication.meshtastic.nodeNum',
      value: nodeInfo.num,
    },
    {
      path: 'communication.meshtastic.shortName',
      value: nodeInfo.user.shortName,
    },
    {
      path: 'communication.meshtastic.longName',
      value: nodeInfo.user.longName,
    },
  ];

  app.handleMessage('signalk-meshtastic', {
    context,
    updates: [
      {
        source: {
          label: 'signalk-meshtastic',
        },
        timestamp: new Date().toISOString(),
        values,
      },
    ],
  });
}

module.exports = (app) => {
  const plugin = {};
  let device;
  let unsubscribes = [];
  const nodes = {};
  const telemetry = {};
  let publishInterval;
  plugin.id = 'signalk-meshtastic';
  plugin.name = 'Meshtastic';
  plugin.description = 'Connect Signal K with the Meshtastic LoRa mesh network';

  // Workaround for loading ESM library
  import('@meshtastic/core')
    .then((lib) => {
      MeshDevice = lib.MeshDevice;
      return import('@meshtastic/transport-http');
    })
    .then((lib) => {
      TransportHTTP = lib.TransportHTTP;
      return import('@bufbuild/protobuf');
    })
    .then((lib) => {
      create = lib.create;
      toBinary = lib.toBinary;
      return import('@meshtastic/protobufs');
    })
    .then((lib) => {
      Protobuf = lib;
      app.setPluginStatus('Meshtastic library loaded');
    })
    .catch((e) => {
      app.setPluginError(`Failed to load Meshtastic library: ${e.message}`);
    });

  plugin.start = (settings) => {
    if (!TransportHTTP) {
      app.setPluginStatus('Waiting for Meshtastic library to load');
      setTimeout(() => {
        plugin.start(settings);
      }, 1);
      return;
    }

    const nodeDbFile = join(app.getDataDirPath(), 'node-db.json');

    publishInterval = setInterval(() => {
      if (!device) {
        // Not connected to Meshtastic yet
        return;
      }
      if (!settings.communications || !settings.communications.send_environment_metrics) {
        return;
      }
      const values = {};
      if (telemetry['environment.outside.temperature']) {
        values.temperature = telemetry['environment.outside.temperature'] - 273.15;
      }
      if (telemetry['environment.outside.relativeHumidity']) {
        values.relativeHumidity = telemetry['environment.outside.relativeHumidity'] * 100;
      }
      if (telemetry['environment.outside.pressure']) {
        values.barometricPressure = telemetry['environment.outside.pressure'] / 100;
      }
      if (telemetry['environment.wind.directionTrue']) {
        values.windDirection = Math.floor(telemetry['environment.wind.directionTrue'] * (180 / Math.PI));
      }
      if (telemetry['environment.wind.speedOverGround']) {
        values.windSpeed = telemetry['environment.wind.speedOverGround'];
      }
      if (telemetry['electrical.batteries.house.voltage']) {
        values.voltage = telemetry['electrical.batteries.house.voltage'];
      }
      if (telemetry['electrical.batteries.house.current']) {
        values.current = telemetry['electrical.batteries.house.current'] * 1000;
      }
      if (telemetry['navigation.anchor.distanceFromBow']) {
        // Using distance is a bit silly here as the unit is mm, but what can we do
        values.distance = telemetry['navigation.anchor.distanceFromBow'] * 1000;
      }
      if (Object.keys(values).length === 0) {
        return;
      }
      const telemetryMessage = create(Protobuf.Telemetry.TelemetrySchema, {
        variant: {
          case: 'environmentMetrics',
          value: create(Protobuf.Telemetry.EnvironmentMetricsSchema, values),
        },
      });
      device.sendPacket(
        toBinary(Protobuf.Telemetry.TelemetrySchema, telemetryMessage),
        Protobuf.Portnums.PortNum.TELEMETRY_APP,
        'broadcast',
        0,
        true,
        false,
      )
        .catch((e) => app.error(`Failed to send telemetry: ${e.message}`));
    }, 60000 * 4);

    function setConnectionStatus() {
      const now = new Date();
      const nodesOnline = Object.keys(nodes)
        .filter((nodeId) => {
          if (nodes[nodeId].thisNode) {
            // Ignore own node
            return false;
          }
          if (nodes[nodeId].seen.getTime() > now.getTime() - 600000) {
            // Seen in last 10min
            return true;
          }
          return false;
        });
      app.setPluginStatus(`Node at ${settings.device.address} can see ${nodesOnline.length} Meshstastic nodes`);
      app.handleMessage('signalk-meshtastic', {
        context: 'vessels.self',
        updates: [
          {
            source: {
              label: 'signalk-meshtastic',
            },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: 'communication.meshtastic.nodesVisible',
                value: nodesOnline.length,
              },
            ],
          },
        ],
      });
    }

    app.setPluginStatus('Loading Meshtastic node database');
    readFile(nodeDbFile, 'utf-8')
      .catch(() => '{}')
      .then((nodeDb) => {
        const nodeDbData = JSON.parse(nodeDb);
        Object.keys(nodeDbData)
          .forEach((nodeNum) => {
            nodes[nodeNum] = nodeDbData[nodeNum];
            nodes[nodeNum].seen = new Date(nodeDbData[nodeNum].seen);
          });
        app.setPluginStatus(`Connecting to Meshtastic node ${settings.device.address}`);
        return TransportHTTP.create(settings.device.address);
      })
      .then((transport) => {
        device = new MeshDevice(transport);

        device.events.onMyNodeInfo.subscribe((myNodeInfo) => {
          if (!nodes[myNodeInfo.myNodeNum]) {
            nodes[myNodeInfo.myNodeNum] = {};
          }
          nodes[myNodeInfo.myNodeNum].thisNode = true;
          setConnectionStatus();
        });
        device.events.onNodeInfoPacket.subscribe((nodeInfo) => {
          if (!nodes[nodeInfo.num]) {
            nodes[nodeInfo.num] = {};
          }
          nodes[nodeInfo.num].longName = nodeInfo.user.longName;
          nodes[nodeInfo.num].shortName = nodeInfo.user.shortName;
          nodes[nodeInfo.num].seen = new Date();
          nodeToSignalK(app, nodes[nodeInfo.num], nodeInfo);
          setConnectionStatus();
          writeFile(nodeDbFile, JSON.stringify(nodes, null, 2), 'utf-8')
            .catch((e) => {
              app.error(`Failed to store node DB: ${e.message}`);
            });
        });
        device.events.onMeshPacket.subscribe((packet) => {
          if (!nodes[packet.from]) {
            nodes[packet.from] = {};
          }
          nodes[packet.from].seen = new Date();
          setConnectionStatus();
        });
        device.events.onMessagePacket.subscribe((message) => {
          if (message.type !== 'direct') {
            // Not DM
            return;
          }
          const crew = settings.nodes
            .filter((node) => {
              if (node.role === 'crew') {
                return true;
              }
              return false;
            })
            .map((node) => node.node);
          if (crew.indexOf(message.from) === -1) {
            // Not from crew
            return;
          }
          const switching = message.data.match(/turn ([a-z0-9]+) (on|off)/i);
          if (settings.communications
            && settings.communications.digital_switching
            && switching) {
            const light = switching[1];
            const value = switching[2] === 'on';
            app.putSelfPath(`electrical.switches.${light}.state`, value, (res) => {
              if (res.state !== 'COMPLETED') {
                return;
              }
              if (res.statusCode !== 200) {
                device.sendText(res.message, message.from, true, false)
                  .catch((e) => app.error(`Failed to send message: ${e.message}`));
                return;
              }
              device.sendText(`OK, ${light} is ${switching[2]}`, message.from, true, false)
                .catch((e) => app.error(`Failed to send message: ${e.message}`));
            });
          }
        });

        // Subscribe to Signal K values we may want to transmit to Meshtastic
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: [
              {
                path: 'navigation.position',
                period: 600000,
              },
              {
                path: 'notifications.*',
                policy: 'instant',
              },
              {
                path: 'environment.outside.temperature',
                period: 1000,
              },
              {
                path: 'environment.outside.relativeHumidity',
                period: 1000,
              },
              {
                path: 'environment.outside.pressure',
                period: 1000,
              },
              {
                path: 'environment.wind.directionTrue',
                period: 1000,
              },
              {
                path: 'environment.wind.speedOverGround',
                period: 1000,
              },
              {
                path: 'electrical.batteries.house.voltage',
                period: 1000,
              },
              {
                path: 'electrical.batteries.house.current',
                period: 1000,
              },
              {
                path: 'navigation.anchor.distanceFromBow',
                period: 1000,
              },
            ],
          },
          unsubscribes,
          (subscriptionError) => {
            app.error(`Error: ${subscriptionError}`);
          },
          (delta) => {
            if (!delta.updates) {
              return;
            }
            delta.updates.forEach((u) => {
              if (!u.values) {
                return;
              }
              u.values.forEach((v) => {
                if (v.path === 'navigation.position') {
                  if (!device) {
                    // Not connected to Meshtastic yet
                    return;
                  }
                  if (!settings.communications || !settings.communications.send_position) {
                    return;
                  }
                  const setPositionMessage = create(Protobuf.Admin.AdminMessageSchema, {
                    payloadVariant: {
                      case: 'setFixedPosition',
                      value: create(Protobuf.Mesh.PositionSchema, {
                        latitudeI: Math.floor(v.value.latitude / 1e-7),
                        longitudeI: Math.floor(v.value.longitude / 1e-7),
                      }),
                    },
                  });
                  device.sendPacket(
                    toBinary(Protobuf.Admin.AdminMessageSchema, setPositionMessage),
                    Protobuf.Portnums.PortNum.ADMIN_APP,
                    'self',
                    0,
                    true,
                    false,
                  )
                    .catch((e) => app.error(`Failed to set node position: ${e.message}`));
                  return;
                }
                if (v.path.indexOf('notifications.') === 0) {
                  if (!device) {
                    // Not connected to Meshtastic yet
                    return;
                  }
                  if (!settings.communications || !settings.communications.send_alerts) {
                    return;
                  }
                  if (!v.value) {
                    return;
                  }
                  if (!v.value.state || ['alarm', 'emergency'].indexOf(v.value.state) === -1) {
                    return;
                  }
                  const crew = settings.nodes.filter((node) => node.role === 'crew');
                  if (!crew.length) {
                    return;
                  }
                  crew.reduce(
                    (prev, member) => prev.then(() => device.sendText(`\u0007 ${v.value.message}`, member.node, true, false)),
                    Promise.resolve(),
                  )
                    .catch((e) => app.error(`Failed to send alert: ${e.message}`));
                  return;
                }
                // The others go to the telemetry object
                telemetry[v.path] = v.value;
              });
            });
          },
        );

        device.log.settings.minLevel = settings.device.log_level;
        return device.configure();
      })
      .catch((e) => {
        // Configure often times out, we can ignore it
        app.error(`Failed to connect: ${e.message}`);
      })
      .then(() => {
        app.setPluginStatus(`Connected to Meshtastic node ${settings.device.address}`);
      });
  };
  plugin.stop = () => {
    if (publishInterval) {
      clearInterval(publishInterval);
    }
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
  };
  plugin.schema = () => {
    function nodeList() {
      if (Object.keys(nodes).length === 0) {
        return undefined;
      }
      return Object.keys(nodes)
        .filter((nodeId) => {
          if (nodes[nodeId].thisNode) {
            return false;
          }
          return true;
        })
        .map((nodeId) => {
          const node = nodes[nodeId];
          return {
            const: parseInt(nodeId, 10),
            title: `${nodeId} ${node.shortName} (${node.longName})`,
          };
        });
    }
    const schema = {
      type: 'object',
      properties: {
        device: {
          type: 'object',
          title: 'Meshtastic device connection settings',
          properties: {
            transport: {
              type: 'string',
              default: 'http',
              title: 'How to connect to the boat Meshtastic node',
              oneOf: [
                {
                  const: 'http',
                  title: 'HTTP (nodes connected to same network, typically ESP32)',
                },
              ],
            },
            address: {
              type: 'string',
              default: 'meshtastic.local',
              title: 'Address of the Meshtastic node',
            },
            log_level: {
              type: 'integer',
              default: 6,
              title: 'Meshtastic log level',
            },
          },
        },
        nodes: {
          type: 'array',
          title: 'Related Meshtastic nodes',
          minItems: 0,
          items: {
            type: 'object',
            required: [
              'node',
              'role',
            ],
            properties: {
              node: {
                type: 'integer',
                title: 'Node',
                oneOf: nodeList(),
              },
              role: {
                type: 'string',
                title: 'Role',
                oneOf: [
                  {
                    const: 'crew',
                    title: 'Node carried by crew member',
                  },
                  {
                    const: 'dinghy',
                    title: 'Dinghy tracker node',
                  },
                  {
                    const: 'onboard',
                    title: 'Onboard equipment',
                  },
                ],
              },
            },
          },
        },
        communications: {
          type: 'object',
          title: 'Communications with Meshtastic',
          properties: {
            send_position: {
              type: 'boolean',
              title: 'Update Meshtastic node position from Signal K vessel position',
              default: true,
            },
            send_alerts: {
              type: 'boolean',
              title: 'Send alerts to crew via Meshtastic',
              default: true,
            },
            send_environment_metrics: {
              type: 'boolean',
              title: 'Send environment metrics (wind, temperature, etc) to Meshtastic',
              default: false,
            },
            digital_switching: {
              type: 'boolean',
              title: 'Allow crew members to change digital switch status by Meshtastic message ("turn decklight on")',
              default: false,
            },
          },
        },
      },
    };
    return schema;
  };

  return plugin;
};
