Signal K integration with Meshtastic
====================================

This plugin enables vessels running [Signal K](https://signalk.org) to interact with the [Meshtastic](https://meshtastic.org) mesh network. Meshtastic allows radio communications between relatively inexpensive LoRa devices over long distances.

Being a mesh network, there is no need for external telecommunications infrastructure or monthly payments. This means communication between Meshtastic devices onboard and on shore can work just as well in the Finnish Archipelago Sea as in the Tuamotus. In more densely populated places communications may benefit from other Meshtastic users relaying the messages, making it possible to communicate with the boat from for example across a city.

This plugin is designed to work with regular unmodified Meshtastic devices and settings. You can keep your boat and other Meshtastic nodes either in the public channel, or [set up your private mesh](https://meshtastic.org/docs/configuration/tips/#creating-a-private-primary-with-default-secondary).

Many different kinds of Meshtastic devices are available, from basic microcontroller boards to ready-to-go consumer devices. Some are entirely standalone with screens and keyboards, and others need a smartphone app.

[Here is a good introduction](https://tech.gillyb.net/understanding-meshtastic-off-grid-communication-made-simple/) to Meshtastic:
> Picture this: you’re a family is anchored in a bay. Parents are hiking inland, kids are visiting friends on another boat, and you’re on your boat (“Boat Node”) in the middle. When the kids send, “What’s for dinner?”, Meshtastic uses “flood routing” to make sure it reaches everyone.
> Here’s how it works:
> - The kids’ node sends the message.
> - Boat Node receives it and decides, “This is new—let’s pass it on!”
> - Boat Node rebroadcasts the message.
> - Parents’ node, unable to hear the kids directly, receives it through Boat Node.

## Features

* Connect to a Meshtastic node
* Keep a persistent database of all seen Meshtastic nodes
* Update Meshtastic node position from Signal K GNSS position
* Send Signal K alerts as Meshtastic text messages to crew
* Sharing weather station data from Signal K (wind, temperature, etc) over Meshtastic

## Planned features

* Guard mode to alert if the tracked dinghy moves
* Alerts for crew or dighy tracker devices running low on battery
* Basic text commands over Meshtastic to query vessel status or for example to flip digital switches (_"Boat, turn deck light on"_)
* Keeping a mileage log for the dinghy
* Associating Meshtastic nodes with other (AIS) vessels

## Requirements

* This plugin running inside your Signal K installation
* One [Meshtastic device](https://meshtastic.org/docs/hardware/devices/) running and connected to the same network (typically boat WiFi) as Signal K
* At least one additional Meshtastic device for the crew ashore
* Optionally, a Meshtastic GPS tracker device installed in the dinghy

LoRa is line-of-sight communications quite similarly to VHF. Communications range would greatly benefit from a Meshtastic repeater installed high in the mast. Similarly, repeaters on nearby hills or high buildings can be helpful. But just with the boat node and the node carried by crew it should be possible to reach ranges of over 1km.

## Getting started

* Configure your "boat Meshtastic node" device so that it is connected to your boat network
* If you have a valid Ship Station License, add your callsign to the long name of the node. Typical pattern is `<Vessel name> DE <Callsign>`, for example _"Lille Oe DE DH8613"_
* Install and enable this plugin
* Wait for some minutes for the plugin to see nearby Meshtastic nodes
* Configure plugin and set appropriate roles for the crew and dinghy tracker Meshtastic devices
