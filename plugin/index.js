// Hack for Node.js compatibility of Meshtastic Deno lib
const crypto = require('node:crypto');
global.crypto = crypto;

// The ES modules we'll need to import
let MeshDevice, TransportHTTP, create, Protobuf;

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
      return import('@meshtastic/protobufs');
    })
    .then((lib) => {
      Protobuf = lib;
      app.setPluginStatus('Meshtastic library loaded');
    })
    .catch((e) => {
      app.setPluginError(`Failed to load Meshtastic library: ${e.message}`);
    });;

  plugin.start = (settings) => {
    if (!TransportHTTP) {
      app.setPluginStatus('Waiting for Meshtastic library to load');
      setTimeout(() => {
        plugin.start(settings);
      }, 1);
      return;
    }

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
      app.setPluginStatus(`Node at ${settings.address} can see ${nodesOnline.length} Meshstastic nodes`);
    }

    app.setPluginStatus(`Connecting to Meshtastic node ${settings.address}`);
    TransportHTTP
      .create(settings.address)
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
          console.log(nodeInfo);
          if (!nodes[nodeInfo.num]) {
            nodes[nodeInfo.num] = {};
          }
          nodes[nodeInfo.num].longName = nodeInfo.user.longName;
          nodes[nodeInfo.num].shortName = nodeInfo.user.shortName;
          nodes[nodeInfo.num].seen = new Date();
          nodeToSignalK(app, nodes[nodeInfo.num], nodeInfo);
          setConnectionStatus();
        });
        device.events.onMeshPacket.subscribe((packet) => {
          if (!nodes[packet.from]) {
            nodes[packet.from] = {};
          }
          nodes[packet.from].seen = new Date();
          setConnectionStatus();
        });

        return device.configure()
      })
      .catch((e) => {
        // Configure often times out, we can ignore it
        console.log(e);
        return;
      })
      .then(() => {
        app.setPluginStatus(`Connected to Meshtastic node ${settings.address}`);

        // Subscribe to Signal K values we may want to transmit to Meshtastic
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: [
              {
                path: 'navigation.position',
                period: 600000,
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
                  device.setPosition(create(Protobuf.Mesh.PositionSchema, {
                    latitude_i: Math.floor(v.value.latitude / 1e-7),
                    longitude_i: Math.floor(v.value.longitude / 1e-7),
                  }))
                    .catch((e) => app.error(`Failed to set node position: ${e.message}`));
                }
              });
            });
          },
        );
      });

  };
  plugin.stop = () => {};
  plugin.schema = {
    type: 'object',
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
      communications: {
        type: 'object',
        title: 'Communications with Meshtastic',
        properties: {
          send_position: {
            type: 'boolean',
            title: 'Update Meshtastic node position from Signal K vessel position',
            default: true,
          }
        },
      }
    },
  };

  return plugin;
};
