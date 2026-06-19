function vesselIcon(vessel) {
  let icon = 128741; // Motorboat
  if (String(vessel.mmsi).substr(0, 3) === '972'
    || String(vessel.mmsi).substr(0, 3) === '974'
    || String(vessel.mmsi).substr(0, 3) === '970') {
    icon = 128735; // MOB, EPIRB, or SART
    return icon;
  }
  if (vessel.sensors
     && vessel.sensors.ais
     && vessel.sensors.ais.class
     && vessel.sensors.ais.class.value === 'A') {
    icon = 128674; // Ship
  }
  if (vessel.design
    && vessel.design.aisShipType
    && vessel.design.aisShipType.value) {
    switch (vessel.design.aisShipType.value.id) {
      case 36: {
        icon = 9973; // Sailboat
        break;
      }
      default: {
        break;
      }
    }
  }
  return icon;
}

function sendWaypoint(
  id,
  coordinates,
  name,
  description,
  icon,
  length,
  target,
  device,
  create,
  Protobuf,
) {
  const setWaypointMessage = create(Protobuf.Mesh.WaypointSchema, {
    id,
    latitudeI: Math.floor(coordinates.latitude / 1e-7),
    longitudeI: Math.floor(coordinates.longitude / 1e-7),
    expire: Math.floor((new Date().getTime() / 1000) + (length * 60 * 60)),
    name,
    description,
    icon,
  });
  return device.sendWaypoint(setWaypointMessage, target, 0);
}

function sendMOB(path, value, app, device, create, Protobuf) {
  let mobPosition;
  let mobVessel = {
    name: 'MOB beacon',
    mmsi: '9712234567',
  };
  if (value.data && value.data.mmsi) {
    mobVessel.mmsi = value.data.mmsi;
  }
  if (value.position) {
    // signalk-mob-notifier and freeboard-sk include position in the notification
    mobPosition = value.position;
  } else {
    const mmsi = path.split('.').at(-1);
    mobVessel = app.signalk.root.vessels[`vessels.urn:mrn:imo:mmsi:${mmsi}`];
    if (mobVessel && mobVessel.navigation && mobVessel.navigation.position) {
      mobPosition = mobVessel.navigation.position;
      if (mobPosition.value) {
        mobPosition = mobPosition.value;
      }
    }
  }
  if (!mobPosition || !Number.isFinite(mobPosition.latitude)) {
    // No coordinates, can't create waypoint
    return Promise.resolve();
  }
  return sendWaypoint(
    mobVessel.mmsi,
    mobPosition,
    mobVessel.name || `Beacon ${mobVessel.mmsi}`,
    `MOB beacon ${mobVessel.mmsi}`,
    vesselIcon(mobVessel),
    1,
    'broadcast',
    device,
    create,
    Protobuf,
  );
}

module.exports = {
  vesselIcon,
  sendWaypoint,
  sendMOB,
};
