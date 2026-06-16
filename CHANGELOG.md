* 1.3.0 (git main)
  - Removed support for serial connections as they require post-install scripts
* 1.2.4 (2026-02-15)
  - Corrupted Node DB file should no longer crash the plugin
* 1.2.3 (2025-10-15)
  - Nodes that haven't been seen in last two days are no longer registered to Signal K data structure
  - Added safeties for various non-numeric telemetry and coordinate values
* 1.2.2 (2025-10-01)
  - Set "last seen" timestamp of nodes based on packet payloads, not the time they're received
  - Send timestamp with telemetry
  - Fixed issue with persising node-to-vessel matches from `DE <callsign>`
* 1.2.1 (2025-09-28)
  - Fixed issue with Signal K servers that don't have navigation.position set
* 1.2.0 (2025-09-28)
  - Support for Node.js older than 22.x, for example as seen in Venus OS Large
  - Safety for nodes in DB that don't have a "last seen" timestamp
  - Made connection status notifications clearer
* 1.1.2 (2025-09-25)
  - Added support for the new roles from Meshtastic 2.7 (`ROUTER_LATE` and `CLIENT_BASE`)
  - Fixed issue with sending a bell with alerts that have sound enabled
* 1.1.1 (2025-09-18)
  - Fixed empty response text message to digital switching actions
  - Added support for the proposed Signal K MOB position specification
* 1.1.0 (2025-09-11)
  - Added support for Serial transport with the Meshtastic device
* 1.0.0 (2025-09-11)
  - Initial release with HTTP and TCP transports
