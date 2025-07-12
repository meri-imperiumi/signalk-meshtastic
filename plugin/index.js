// Hack for Node.js compatibility of Meshtastic Deno lib
const crypto = require('node:crypto');
global.crypto = crypto;

let MeshDevice, TransportHTTP;

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
            title: 'HTTP (nodes connected to same WiFi)',
          },
        ],
      },
      address: {
        type: 'string',
        default: 'meshtastic.local',
        title: 'Address of the Meshtastic node',
      },
    },
  };

  return plugin;
};
