"use strict";

/// TODO:
// - Zone2
// - Persistant GUID's? We don't want people to lose their flows because an ID is not matching.
// --> Keeping the ID's the same doesn't seem to help :(.
// - Channel UP / DOWN.

var net = require('net');

var devices = {};       // Denon AVR Device List. 
var commands = {};      // A buffer of requests to make to a specific Denon AVR by IP.

const WRITE_CLOSE_MODE = 0;             // We write a command and immediately close the socket afterwards.
const READ_MODE = 1;                    // We write a command and return the result, we keep the connection open. Must be closed manually.
const TELNET_RECONNECT_TIME_OUT = 100;  // Time before we consider a socket truly closed. Denon AVR doesn't accept a new connection while the old is open for some time.
const LOOP_DELAY = 10;                  // The time in between command buffer handling.

function AsBytes(str) {
    var array = new Buffer(str.length + 1);

    for(var i = 0; i < str.length; i++) {
        array[i] = str.charCodeAt(i);
    }

    array[str.length] = 13; // CR

    return array;
}

function Loop() {
    for(var ip in commands) {
        if(!commands.hasOwnProperty(ip)) continue; // Don't do prototype properties...

        if(commands[ip].socket == null && commands[ip].list.length > 0) {
            var nc = commands[ip].list.shift();

            // Some code duplication here.
            if(nc.mode == WRITE_CLOSE_MODE) {
                // Create this function object thing to not mess up things because we're inside a loop.
                var nf = function(ipaddress, command, callback) {
                    Homey.log("Sending write-close command " + command);
                    
                    commands[ipaddress].socket = new net.Socket();
                    var cd = {
                        port: 23,
                        host: ipaddress
                    };

                    var client = commands[ipaddress].socket.connect(cd, () => {
                        client.write(AsBytes(command), () => {
                            client.end();

                            if(callback != null && callback != undefined)
                                callback(true);
                        });
                    });

                    client.on('close', ()=> {
                        Homey.log("Socket closed");

                        setTimeout(function() {
                            commands[ipaddress].socket = null; 
                        }, TELNET_RECONNECT_TIME_OUT);
                    });

                    client.on('error', (err) => {
                        Homey.log(err);
                        client.end();

                        if(callback != null && callback != undefined)
                            callback(false);
                    });
                };

                nf(ip, nc.command, nc.callback);
            } else if(nc.mode == READ_MODE) {
                var nf = function(ipaddress, command, callback) {
                    Homey.log("Sending read command " + command);
                    
                    commands[ipaddress].socket = new net.Socket();
                    var cd = {
                        port: 23,
                        host: ipaddress
                    };

                    var client = commands[ipaddress].socket.connect(cd, () => {
                        client.write(AsBytes(command));
                    });

                    client.on('data', (data)=> {
                        var status = data.toString();
                        status = status.substring(0, status.length-1); // We already remove CR here for convience.

                        callback(status, client);
                    });

                    client.on('close', ()=> {
                        Homey.log("Socket closed");

                        setTimeout(function() {
                            commands[ipaddress].socket = null;
                        }, TELNET_RECONNECT_TIME_OUT);
                    });

                    client.on('error', (err) => {
                        Homey.log(err);
                        callback(null, client);        
                    });
                };

                nf(ip, nc.command, nc.callback);
            }
        } else {
            // We're busy. Waiting on completion.
        }
    }
    
    setTimeout(Loop, LOOP_DELAY);
}

function ASyncRequest(mode, ip, command, callback) {
    var request = {};
    request.command = command;
    request.callback = callback;
    request.mode = mode;

    // If no such command buffer exists.
    if(commands[ip] == undefined || commands[ip] == null) {
        commands[ip] = {};
        commands[ip].socket = null;
        commands[ip].list = new Array();
    }

    commands[ip].list.push(request);
}

function WriteCloseRequest(ip, command, callback) {
    ASyncRequest(WRITE_CLOSE_MODE, ip, command, callback);
}

function ReadRequest(ip, command, callback) {
    ASyncRequest(READ_MODE, ip, command, callback);
}

// the `init` method is called when your driver is loaded for the first time
module.exports.init = function( devices_data, callback ) {
    devices_data.forEach(function(device_data){
        initDevice( device_data );
    })

    Homey.log("Initializing Denon Device Driver");

    Loop();
    
    callback();
}

// the `added` method is called is when pairing is done and a device has been added
module.exports.added = function( device_data, callback ) {
    Homey.log("New Denon AVR added");
    Homey.log(device_data);

    initDevice( device_data );
    callback( null, true );
}

// the `delete` method is called when a device has been deleted by a user
module.exports.deleted = function( device_data, callback ) {
    delete devices[ device_data.id ];
    callback( null, true );
}

module.exports.renamed = function(device_data, new_name) {
	// update the devices array we keep
	devices[device_data.id].data.name = new_name;
};

// the `pair` method is called when a user start pairing
module.exports.pair = function( socket ) {
    socket.on('list_devices', function( data, callback ){
        Homey.log("Device Pairing method called.");
        Homey.log(data);
        var device_data = {
            name: "New Denon Amplifier",
            data: {
                id: data.id
            }
        }

        callback( null, [ device_data ] );
    });
}

// a helper method to get a device from the devices list by it's device_data object
function getDeviceByData( device_data ) {
    var device = devices[ device_data.id ];
    if( typeof device === 'undefined' ) {
        return new Error("invalid_device");
    } else {
        return device;
    }
}

// a helper method to add a device to the devices list
function initDevice( device_data ) {
    devices[ device_data.id ] = {};
    devices[ device_data.id ].state = { onoff: true };
    devices[ device_data.id ].data = device_data;

    module.exports.getSettings(device_data, function(err, settings) {
        devices[device_data.id].settings = settings;
    });
}

/// SETTINGS HANDLING
module.exports.settings = function(device_data, newSettingsObj, oldSettingsObj, changedKeysArr, callback) {
    // We just slave-ishly assume anything is okay for an IP address.
    // And assuming this device exists in our list.
    devices[device_data.id].settings = newSettingsObj;

    callback(null, true);
}

/// ACTION HANDLING
Homey.manager('flow').on('action.com.moz.denon.actions.poweron', function(callback, args) {
    Homey.log("Power On");
    var device = devices[args.device.id];
    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], 'PWON');

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.poweroff', function(callback, args) {
    Homey.log("Power Off");
    var device = devices[args.device.id];
    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], 'PWSTANDBY');

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.powertoggle', function(callback, args) {
    Homey.log("Toggling Power");
    var device = devices[args.device.id];

    ReadRequest(device.settings['com.moz.denon.settings.ip'], 'PW?', (result, socket) => {
        if(result == null) {
            Homey.log("Unreachable Denon Receiver");
            socket.end();
        } else {
            Homey.log(result);

            if(result == 'PWON' || result == 'PWSTANDBY') {
                var pass = 'PWON';
                if(result == 'PWON')
                    pass = 'PWSTANDBY';

                socket.write(AsBytes(pass), ()=> {
                    socket.end();
                });
            }
            // Otherwise we've received some data about ZONE 2. Which fucks us up.
        }
    });

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.mute', function(callback, args) {
    Homey.log("Muting");
    var device = devices[args.device.id];
    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], 'MUON');

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.unmute', function(callback, args) {
    Homey.log("Unmuting");
    var device = devices[args.device.id];
    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], 'MUOFF');

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.mutetoggle', function(callback, args) {
    Homey.log("Toggling Mute");
    var device = devices[args.device.id];

    ReadRequest(device.settings['com.moz.denon.settings.ip'], 'MU?', (result, socket) => {
        if(result != null) {
            var mute = ((result == 'MUON') ? 'MUOFF' : 'MUON');

            socket.write(AsBytes(mute), () => {
                socket.end();
            });     
        } else {
            socket.end();
        }
    });

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.source', function(callback, args) {
    Homey.log("Setting Source");
    var device = devices[args.device.id];

    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], 'SI' + args.channel);

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.volume', function(callback, args) {
    Homey.log("Change Volume");
    var device = devices[args.device.id];

    ReadRequest(device.settings['com.moz.denon.settings.ip'], 'MV?', (result, socket) => {
        if(result != null) {
            var volume = parseInt(result.substring(2));
            var add = parseFloat(args.db) * 10;

            socket.write(AsBytes('MV'+(volume+add)), () => {
                socket.end();
            });            
        } else {
            socket.end();
        }
    });

	callback(null, true);
});

Homey.manager('flow').on('action.com.moz.denon.actions.volumeset', function(callback, args) {
    Homey.log("Setting Volume");
    var device = devices[args.device.id];

    var volume = parseFloat(args.db) * 10;
    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], 'MV' + volume);

	callback(null, true);
});

Homey.manager('flow').on('condition.com.moz.denon.conditions.power', function( callback, args ){
    Homey.log("Getting power state for condition.");
    var device = devices[args.device.id];

    module.exports.capabilities.onoff.get(args.device, (object, state) => {
        callback(null, state);
    });
});

Homey.manager('flow').on('condition.com.moz.denon.conditions.channel', function( callback, args ){
    Homey.log("Getting channel for condition.");
    var device = devices[args.device.id];

    ReadRequest(device.settings['com.moz.denon.settings.ip'], 'SI?', (result, socket) => {
        if(result.substring(0, 2) != 'SI')  // We ignore any SV, video mode data that comes second.
            return;

        if(result != null) {
            socket.end();

            Homey.log("Current Source is: " + result);
            callback(null, result == 'SI' + args.channel);
        } else {
            socket.end();
            callback(null, false);
        }
    });
});

/// CAPABILITY GARBAGE. Don't see the use for this. Should work though.

// these are the methods that respond to get/set calls from Homey
// for example when a user pressed a button
module.exports.capabilities = {};
module.exports.capabilities.onoff = {};
module.exports.capabilities.onoff.get = function( device_data, callback ) {
    var device = getDeviceByData( device_data );
    if( device instanceof Error ) return callback( device );

    Homey.log("Getting Denon device status.");

    ReadRequest(device.settings['com.moz.denon.settings.ip'], 'PW?', (result, socket) => {
        if(result != null && result.substring(0, 2) != 'PW')  // We don't handle Zone 2.
            return;

        socket.end();

        if(result == null || result == 'PWSTANDBY')
            device.state.onoff = false;
        else
            device.state.onoff = true;

        return callback( null, device.state.onoff );
    });
}
module.exports.capabilities.onoff.set = function( device_data, onoff, callback ) {
    var device = getDeviceByData( device_data );
    if( device instanceof Error ) return callback( device );

    Homey.log("Setting Denon device power.");
    device.state.onoff = onoff;

    // here you would use a wireless technology to actually turn the device on or off
    WriteCloseRequest(device.settings['com.moz.denon.settings.ip'], onoff ? 'PWON' : 'PWSTANDBY'); 

    // also emit the new value to realtime
    // this produced Insights logs and triggers Flows
    self.realtime( device_data, 'onoff', device.state.onoff)

    return callback( null, device.state.onoff );
}