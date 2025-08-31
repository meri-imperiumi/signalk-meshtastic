exports.vesselIcon = (vessel) => {
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
};
